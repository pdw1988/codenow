//! Redis 客户端（码上查 · Redis）：单机 / 哨兵 / 集群，可走跳板机。SCAN 列键、执行任意命令。
//!
//! 键和值一律按原始字节进出（前端 base64）：Java 序列化、gzip 这类二进制值
//! 当 UTF-8 字符串过一趟就坏了，而且坏了看不出来。
//!
//! 安全规则只在这里判，前端置灰只是提示：危险命令任何环境都拦；只读连接（生产）
//! 只放行读命令白名单——没见过的命令一律当写，宁可多拦。
//!
//! 集群不用 redis 库自带的集群客户端：逐个主节点 SCAN、把 TYPE 批量发到键所在的节点，
//! 都要能指定节点。这里自己记「槽 → 节点」，按键算槽路由，遇到 MOVED 刷新、ASK 跟一次。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use redis::{Connection, RedisError, Value};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

use crate::ssh_tunnel::{self, Jump, Tunnel};

const CONNECT_TIMEOUT_SECS: u64 = 10;
const CALL_TIMEOUT_SECS: u64 = 30;
/// SCAN 凑不够一页时最多扫这么久就先交：匹配很稀的模式能把几百万键扫一遍，
/// 剩下的靠「再加载」带着游标接着扫
const SCAN_BUDGET_MS: u64 = 3000;
/// 按前缀批量删一次最多删这么多 / 跑这么久，剩下的前端确认后再删一轮：
/// 一口气删几百万个键会把线上 Redis 压得很重，也没法中途停
const DELETE_CAP: u64 = 20_000;
const DELETE_BUDGET_SECS: u64 = 20;
const SLOTS: usize = 16384;
const OPS_LOG: &str = "redis-ops.log";
const NOT_CONNECTED: &str = "尚未连接，请先点「连接」";
const READONLY: &str = "生产连接只读：改值、删键这类写命令不执行。确实要改，先点「临时允许写入」";

#[derive(Clone)]
struct Params {
    /// 哨兵 / 集群可以填多个，逗号分隔，单个可带 :端口
    host: String,
    port: u16,
    user: String,
    password: String,
    tls: bool,
}

#[derive(Clone, PartialEq, Debug)]
enum Topo {
    Single,
    /// 主节点名（sentinel monitor 后面那个）
    Sentinel(String),
    Cluster,
}

#[derive(Clone)]
struct Spec {
    params: Params,
    topo: Topo,
    jump: Option<Jump>,
}

struct Node {
    /// 主机:端口。集群里是节点自己报的地址，跟 MOVED 里的对得上
    addr: String,
    con: Connection,
}

struct RedisInner {
    spec: Spec,
    /// 单机 / 哨兵只有一个；集群是全部主节点
    nodes: Vec<Node>,
    /// 集群：槽 → nodes 下标。单机 / 哨兵为空
    slots: Vec<u16>,
    /// 只为保活：丢掉就杀 ssh
    _tunnels: Vec<Tunnel>,
    db: i64,
    writable: bool,
}

pub struct RedisState {
    inner: Arc<Mutex<Option<RedisInner>>>,
}

impl RedisState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    version: String,
    /// 服务端自己报的 standalone / cluster / sentinel：选了单机却连到集群节点，前端要提示
    mode: String,
    /// 我们怎么连的：single / sentinel / cluster
    kind: String,
    /// 哨兵：问到的主节点；集群：全部主节点
    nodes: Vec<String>,
    db_count: i64,
    dbs: Vec<DbKeys>,
    writable: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DbKeys {
    db: i64,
    keys: i64,
}

#[derive(Serialize)]
pub struct ScanPage {
    /// 字符串：游标是 64 位无符号数，过 JS number 会丢精度。集群是「节点下标:游标」，
    /// 都是「0」= 扫完
    cursor: String,
    keys: Vec<KeyRow>,
}

#[derive(Serialize)]
pub struct KeyRow {
    k: String,
    t: String,
}

#[derive(Serialize, Debug)]
pub struct DeleteResult {
    deleted: u64,
    /// 还没删完（到了单轮上限）
    more: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum Reply {
    Nil,
    Int(i64),
    /// base64 原始字节
    Str(String),
    Status(String),
    Arr(Vec<Reply>),
    Map(Vec<(Reply, Reply)>),
    Dbl(f64),
    Bool(bool),
}

fn map_err(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let low = s.to_lowercase();
    if low.contains("wrongpass") || low.contains("invalid password") || low.contains("invalid username-password") {
        return "用户名或密码不对".into();
    }
    if low.contains("without any password configured") {
        return "这台 Redis 没设密码，把密码留空再连".into();
    }
    if low.contains("noauth") {
        return "这台 Redis 要密码，请填上密码再连".into();
    }
    if low.contains("db index is out of range") || low.contains("invalid db index") {
        return format!("库号超出范围：{s}");
    }
    if low.contains("cluster support disabled") {
        return "这台不是集群节点，连接方式请选「单机」".into();
    }
    if low.contains("timed out") || low.contains("refused") || low.contains("10060") || low.contains("10061") {
        return format!("连不上主机：{s}");
    }
    s
}

fn lock(slot: &Mutex<Option<RedisInner>>) -> Result<MutexGuard<'_, Option<RedisInner>>, String> {
    slot.lock().map_err(|_| "内部锁失效，请重新连接".to_string())
}

/// 主机:端口。IPv6 加方括号，和集群 MOVED 里的写法一致
fn addr_of(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn split_addr(addr: &str) -> Option<(String, u16)> {
    let (h, p) = addr.rsplit_once(':')?;
    Some((h.trim_start_matches('[').trim_end_matches(']').to_string(), p.parse().ok()?))
}

/// 主机栏：`a,b:26380,[::1]:6379`。只有一个冒号的按 主机:端口 拆，其余（裸 IPv6）用默认端口
fn parse_hosts(field: &str, default_port: u16) -> Vec<(String, u16)> {
    field
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with('[') || s.matches(':').count() == 1 {
                if let Some(hp) = split_addr(s) {
                    return hp;
                }
            }
            (s.trim_start_matches('[').trim_end_matches(']').to_string(), default_port)
        })
        .collect()
}

/// auth=false：哨兵常不设密码，先不带试一次
fn open_at(p: &Params, host: &str, port: u16, db: i64, auth: bool) -> Result<Connection, String> {
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    // 密码不进 URL：特殊字符要百分号转义，漏一个就是「密码不对」。连上再 AUTH。
    // insecure：内网自签证书是常态（同 postgres.rs 的 TLS 放行）；走跳板机时主机是 127.0.0.1，也靠它放行
    let url = if p.tls {
        format!("rediss://{h}:{port}/#insecure")
    } else {
        format!("redis://{h}:{port}/")
    };
    let client = redis::Client::open(url.as_str()).map_err(map_err)?;
    let mut con = client
        .get_connection_with_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .map_err(map_err)?;
    let t = Some(Duration::from_secs(CALL_TIMEOUT_SECS));
    con.set_read_timeout(t).map_err(map_err)?;
    con.set_write_timeout(t).map_err(map_err)?;
    if auth && !p.password.is_empty() {
        let mut c = redis::cmd("AUTH");
        if !p.user.is_empty() {
            c.arg(&p.user);
        }
        c.arg(&p.password);
        c.query::<()>(&mut con).map_err(map_err)?;
    }
    if db != 0 {
        redis::cmd("SELECT").arg(db).query::<()>(&mut con).map_err(map_err)?;
    }
    Ok(con)
}

/// 配了跳板机就先开一条转发再连本机口。host 是「跳板机上看到的」地址
fn connect_via(spec: &Spec, host: &str, port: u16, db: i64, tunnels: &mut Vec<Tunnel>, auth: bool) -> Result<Connection, String> {
    match &spec.jump {
        None => open_at(&spec.params, host, port, db, auth),
        Some(j) => {
            let t = ssh_tunnel::open(j, host, port)?;
            let con = open_at(&spec.params, "127.0.0.1", t.port, db, auth)?;
            tunnels.push(t);
            Ok(con)
        }
    }
}

struct Opened {
    nodes: Vec<Node>,
    slots: Vec<u16>,
    tunnels: Vec<Tunnel>,
}

fn bulk_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::BulkString(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Int(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 问一个哨兵当前主节点在哪。主从切换后重连也走这里，所以不缓存
fn master_from_sentinel(spec: &Spec, host: &str, port: u16, name: &str) -> Result<(String, u16), String> {
    // 哨兵的转发只用这一下，函数结束就关
    let mut tmp = Vec::new();
    let ask = |c: &mut Connection| redis::cmd("SENTINEL").arg("get-master-addr-by-name").arg(name).query::<Value>(c);
    let mut con = connect_via(spec, host, port, 0, &mut tmp, false)?;
    let v = match ask(&mut con) {
        Err(e) if e.to_string().to_lowercase().contains("noauth") && !spec.params.password.is_empty() => {
            con = connect_via(spec, host, port, 0, &mut tmp, true)?;
            ask(&mut con).map_err(map_err)?
        }
        r => r.map_err(|e| {
            if e.to_string().to_lowercase().contains("unknown command") {
                "这个地址不是哨兵（哨兵端口常见 26379）".to_string()
            } else {
                map_err(e)
            }
        })?,
    };
    match v {
        Value::Array(a) => {
            let h = bulk_text(a.first()).ok_or("哨兵返回的主节点地址看不懂")?;
            let p = bulk_text(a.get(1)).and_then(|p| p.parse().ok()).ok_or("哨兵返回的主节点端口看不懂")?;
            Ok((h, p))
        }
        _ => Err(format!("哨兵里没有叫 {name} 的主节点。主节点名可在哨兵上执行 SENTINEL masters 查")),
    }
}

/// CLUSTER SLOTS → [(起, 止, 主节点地址)]。节点报空地址时用连上的那个主机
fn parse_slots(v: &Value, seed_host: &str) -> Result<Vec<(u16, u16, String)>, String> {
    let Value::Array(rows) = v else {
        return Err("CLUSTER SLOTS 返回的不是列表".into());
    };
    let mut out = Vec::new();
    for r in rows {
        let Value::Array(f) = r else { continue };
        let (Some(Value::Int(a)), Some(Value::Int(b)), Some(Value::Array(m))) = (f.first(), f.get(1), f.get(2)) else {
            continue;
        };
        let ip = bulk_text(m.first()).unwrap_or_default();
        let ip = if ip.is_empty() || ip == "?" { seed_host.to_string() } else { ip };
        let Some(Value::Int(port)) = m.get(1) else { continue };
        out.push((*a as u16, *b as u16, addr_of(&ip, *port as u16)));
    }
    if out.is_empty() {
        return Err("集群还没分配槽位（CLUSTER SLOTS 是空的）".into());
    }
    Ok(out)
}

fn cluster_slots(con: &mut Connection, seed_host: &str) -> Result<Vec<(u16, u16, String)>, String> {
    let v: Value = redis::cmd("CLUSTER").arg("SLOTS").query(con).map_err(map_err)?;
    parse_slots(&v, seed_host)
}

/// 按槽位表连齐主节点。reuse 里地址对得上的连接直接拿来用（刷新拓扑时不必全重连）
fn build_cluster(p: &Params, ranges: &[(u16, u16, String)], mut reuse: Vec<Node>) -> Result<(Vec<Node>, Vec<u16>), String> {
    let mut nodes: Vec<Node> = Vec::new();
    let mut slots = vec![0u16; SLOTS];
    for (a, b, addr) in ranges {
        let idx = match nodes.iter().position(|n| &n.addr == addr) {
            Some(i) => i,
            None => {
                let con = match reuse.iter().position(|n| &n.addr == addr) {
                    Some(i) => reuse.swap_remove(i).con,
                    None => {
                        let (h, port) = split_addr(addr).ok_or_else(|| format!("看不懂的节点地址 {addr}"))?;
                        open_at(p, &h, port, 0, true).map_err(|e| format!("集群节点 {addr} 连不上：{e}"))?
                    }
                };
                nodes.push(Node { addr: addr.clone(), con });
                nodes.len() - 1
            }
        };
        for s in *a..=*b {
            if let Some(x) = slots.get_mut(s as usize) {
                *x = idx as u16;
            }
        }
    }
    Ok((nodes, slots))
}

fn open_all(spec: &Spec, db: i64) -> Result<Opened, String> {
    let p = &spec.params;
    let seeds = parse_hosts(&p.host, p.port);
    if seeds.is_empty() {
        return Err("主机还没填".into());
    }
    let mut tunnels = Vec::new();
    match &spec.topo {
        Topo::Single => {
            let (h, port) = &seeds[0];
            let con = connect_via(spec, h, *port, db, &mut tunnels, true)?;
            Ok(Opened { nodes: vec![Node { addr: addr_of(h, *port), con }], slots: Vec::new(), tunnels })
        }
        Topo::Sentinel(name) => {
            let mut errs = Vec::new();
            for (h, port) in &seeds {
                match master_from_sentinel(spec, h, *port, name) {
                    Ok((mh, mp)) => {
                        let con = connect_via(spec, &mh, mp, db, &mut tunnels, true)
                            .map_err(|e| format!("哨兵说主节点是 {}，但连不上：{e}", addr_of(&mh, mp)))?;
                        return Ok(Opened { nodes: vec![Node { addr: addr_of(&mh, mp), con }], slots: Vec::new(), tunnels });
                    }
                    Err(e) => errs.push(format!("{}：{e}", addr_of(h, *port))),
                }
            }
            Err(format!("哨兵都没问到主节点。{}", errs.join("；")))
        }
        Topo::Cluster => {
            if spec.jump.is_some() {
                return Err("集群暂不支持走跳板机：每个节点都要单独转发。可以先按「单机」连其中一个节点".into());
            }
            if db != 0 {
                return Err("集群只有 0 号库，库号请填 0".into());
            }
            let mut errs = Vec::new();
            for (h, port) in &seeds {
                let ranges = open_at(p, h, *port, 0, true).and_then(|mut c| cluster_slots(&mut c, h));
                match ranges {
                    Ok(r) => {
                        let (nodes, slots) = build_cluster(p, &r, Vec::new())?;
                        return Ok(Opened { nodes, slots, tunnels });
                    }
                    Err(e) => errs.push(format!("{}：{e}", addr_of(h, *port))),
                }
            }
            Err(errs.join("；"))
        }
    }
}

/// 整个重连：哨兵重新问主节点（可能刚切过）、集群重新拿拓扑、跳板机重新开转发
fn reopen(inner: &mut RedisInner) -> Result<(), String> {
    let o = open_all(&inner.spec, inner.db)?;
    inner.nodes = o.nodes;
    inner.slots = o.slots;
    inner._tunnels = o.tunnels;
    Ok(())
}

fn refresh_slots(inner: &mut RedisInner) -> Result<(), String> {
    let mut ranges = None;
    for n in inner.nodes.iter_mut() {
        let host = split_addr(&n.addr).map(|(h, _)| h).unwrap_or_default();
        if let Ok(r) = cluster_slots(&mut n.con, &host) {
            ranges = Some(r);
            break;
        }
    }
    let ranges = ranges.ok_or("集群拓扑变了，但哪个节点都问不到新的槽位表，请断开重连")?;
    let old = std::mem::take(&mut inner.nodes);
    let (nodes, slots) = build_cluster(&inner.spec.params, &ranges, old)?;
    inner.nodes = nodes;
    inner.slots = slots;
    Ok(())
}

/// ASK 指到的节点可能还不在表里（槽正在迁），连上加进来
fn ensure_node(inner: &mut RedisInner, addr: &str) -> Result<usize, String> {
    if let Some(i) = inner.nodes.iter().position(|n| n.addr == addr) {
        return Ok(i);
    }
    let (h, port) = split_addr(addr).ok_or_else(|| format!("看不懂的节点地址 {addr}"))?;
    let con = open_at(&inner.spec.params, &h, port, 0, true)?;
    inner.nodes.push(Node { addr: addr.to_string(), con });
    Ok(inner.nodes.len() - 1)
}

/// CRC16/XMODEM，Redis 集群算槽用的就是它
fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

/// 键名里有非空的 {…} 就只算大括号里那段（hash tag），让一组键落在同一个槽
fn key_slot(key: &[u8]) -> u16 {
    let part = key
        .iter()
        .position(|&b| b == b'{')
        .and_then(|s| {
            let rest = &key[s + 1..];
            let e = rest.iter().position(|&b| b == b'}')?;
            (e > 0).then(|| &rest[..e])
        })
        .unwrap_or(key);
    crc16(part) % SLOTS as u16
}

/// 集群重定向：`MOVED 3999 10.0.0.1:6381` / `ASK …`。按文字解，不跟 redis 库错误类型的细节走
fn redirect(msg: &str) -> Option<(bool, String)> {
    let words: Vec<&str> = msg.split_whitespace().collect();
    for (i, w) in words.iter().enumerate() {
        let ask = match w.trim_matches(|c: char| !c.is_ascii_alphabetic()).to_ascii_uppercase().as_str() {
            "MOVED" => false,
            "ASK" => true,
            _ => continue,
        };
        let (Some(slot), Some(addr)) = (words.get(i + 1), words.get(i + 2)) else { continue };
        let addr = addr.trim_end_matches([',', ')', '"']);
        if slot.trim_end_matches(',').parse::<u32>().is_ok() && split_addr(addr).is_some() {
            return Some((ask, addr.to_string()));
        }
    }
    None
}

enum Route<'a> {
    /// 不带键的命令：发给第一个节点
    Any,
    Key(&'a [u8]),
    Node(usize),
}

fn pick(inner: &RedisInner, route: &Route) -> Result<usize, String> {
    let n = inner.nodes.len();
    if n == 0 {
        return Err("连接已断开，请重新连接".into());
    }
    let i = match route {
        Route::Node(i) => *i,
        Route::Key(k) if !inner.slots.is_empty() => inner.slots[key_slot(k) as usize] as usize,
        _ => 0,
    };
    Ok(i.min(n - 1))
}

/// 服务端 timeout 一到就把空闲连接踢掉，用户切走一会儿回来第一下必然失败。
/// 读命令重连后重发一次；写命令只重连不重发——不知道上一次到底写没写进去。
/// 集群 MOVED / ASK 说明命令没执行，写命令也可以重发
fn run<T>(
    inner: &mut RedisInner,
    retry: bool,
    route: Route,
    f: impl Fn(&mut Connection) -> Result<T, RedisError>,
) -> Result<T, String> {
    let i = pick(inner, &route)?;
    let e = match f(&mut inner.nodes[i].con) {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };
    if !inner.slots.is_empty() {
        if let Some((ask, addr)) = redirect(&e.to_string()) {
            if ask {
                let j = ensure_node(inner, &addr)?;
                let con = &mut inner.nodes[j].con;
                redis::cmd("ASKING").query::<()>(con).map_err(map_err)?;
                return f(con).map_err(map_err);
            }
            refresh_slots(inner)?;
            let j = pick(inner, &route)?;
            return f(&mut inner.nodes[j].con).map_err(map_err);
        }
    }
    if e.is_timeout() {
        // 超时后连接上还挂着一个迟到的回复，不换连接的话下一条命令会读到它
        reopen(inner)?;
        return Err(format!("等了 {CALL_TIMEOUT_SECS} 秒没有回复，已重新连接。可能是大键或慢命令"));
    }
    if e.is_connection_dropped() || e.is_io_error() {
        reopen(inner)?;
        if !retry {
            return Err("连接断过，已重新连上。写命令没有自动重发，请再执行一次".into());
        }
        let j = pick(inner, &route)?;
        return f(&mut inner.nodes[j].con).map_err(map_err);
    }
    Err(map_err(e))
}

fn to_reply(v: Value) -> Reply {
    match v {
        Value::Nil => Reply::Nil,
        Value::Int(n) => Reply::Int(n),
        Value::BulkString(b) => Reply::Str(B64.encode(b)),
        Value::SimpleString(s) => Reply::Status(s),
        Value::Okay => Reply::Status("OK".into()),
        Value::Array(a) | Value::Set(a) => Reply::Arr(a.into_iter().map(to_reply).collect()),
        Value::Map(m) => Reply::Map(m.into_iter().map(|(k, v)| (to_reply(k), to_reply(v))).collect()),
        Value::Attribute { data, .. } => to_reply(*data),
        Value::Double(d) => Reply::Dbl(d),
        Value::Boolean(b) => Reply::Bool(b),
        Value::VerbatimString { text, .. } => Reply::Str(B64.encode(text)),
        Value::Push { data, .. } => Reply::Arr(data.into_iter().map(to_reply).collect()),
        other => Reply::Status(format!("{other:?}")),
    }
}

/// INFO 文本里取一个字段（`redis_version:7.2.4`）
fn info_field(info: &str, name: &str) -> Option<String> {
    info.lines().find_map(|l| {
        let (k, v) = l.trim().split_once(':')?;
        (k == name).then(|| v.trim().to_string())
    })
}

/// `db0:keys=12,expires=0,avg_ttl=0` → 每个库的键数。没键的库 INFO 里不出现
fn parse_keyspace(info: &str) -> Vec<DbKeys> {
    info.lines()
        .filter_map(|l| {
            let (k, v) = l.trim().split_once(':')?;
            let db = k.strip_prefix("db")?.parse().ok()?;
            let keys = v.split(',').find_map(|kv| kv.strip_prefix("keys=")?.parse().ok())?;
            Some(DbKeys { db, keys })
        })
        .collect()
}

/// 集群只有 0 号库，键数是各主节点 DBSIZE 之和
fn keyspace(inner: &mut RedisInner) -> Result<Vec<DbKeys>, String> {
    if inner.slots.is_empty() {
        let info: String = run(inner, true, Route::Any, |c| redis::cmd("INFO").arg("keyspace").query(c))?;
        return Ok(parse_keyspace(&info));
    }
    let mut keys = 0;
    for i in 0..inner.nodes.len() {
        keys += run(inner, true, Route::Node(i), |c| redis::cmd("DBSIZE").query::<i64>(c))?;
    }
    Ok(vec![DbKeys { db: 0, keys }])
}

#[derive(Debug, PartialEq)]
pub(crate) enum Class {
    Read,
    Write,
    Blocked(String),
}

/// 只读连接放行的命令。不在表里的一律当写：新版 Redis 加的命令、模块命令都先拦着
const READS: &[&str] = &[
    "GET", "MGET", "STRLEN", "GETRANGE", "SUBSTR", "LCS", "EXISTS", "TYPE", "TTL", "PTTL",
    "EXPIRETIME", "PEXPIRETIME", "SCAN", "HSCAN", "SSCAN", "ZSCAN", "HGET", "HMGET", "HGETALL",
    "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSTRLEN", "HRANDFIELD", "HTTL", "HPTTL", "LRANGE",
    "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER", "SRANDMEMBER",
    "SINTER", "SUNION", "SDIFF", "SINTERCARD", "ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX",
    "ZREVRANGE", "ZREVRANGEBYSCORE", "ZREVRANGEBYLEX", "ZCARD", "ZSCORE", "ZMSCORE", "ZRANK",
    "ZREVRANK", "ZCOUNT", "ZLEXCOUNT", "ZRANDMEMBER", "ZINTER", "ZUNION", "ZDIFF", "ZINTERCARD",
    "PFCOUNT", "GEOPOS", "GEODIST", "GEOHASH", "GEOSEARCH", "GEORADIUS_RO",
    "GEORADIUSBYMEMBER_RO", "XRANGE", "XREVRANGE", "XLEN", "XINFO", "XPENDING", "XREAD",
    "BITCOUNT", "BITPOS", "GETBIT", "BITFIELD_RO", "OBJECT", "DUMP", "DBSIZE", "INFO", "PING",
    "ECHO", "TIME", "LASTSAVE", "RANDOMKEY", "TOUCH", "ROLE", "COMMAND", "SORT_RO", "EVAL_RO",
    "EVALSHA_RO", "FCALL_RO",
];

const BLOCKING: &[&str] = &[
    "BLPOP", "BRPOP", "BRPOPLPUSH", "BLMOVE", "BLMPOP", "BZPOPMIN", "BZPOPMAX", "BZMPOP", "WAIT",
    "WAITAOF",
];

/// 一条命令能不能跑、算读还是写。纯函数，规则全在这一处
pub(crate) fn classify(args: &[Vec<u8>]) -> Class {
    let up = |i: usize| {
        args.get(i)
            .map(|a| String::from_utf8_lossy(a).to_ascii_uppercase())
            .unwrap_or_default()
    };
    let cmd = up(0);
    let sub = up(1);
    let blocked = |why: &str| Class::Blocked(format!("{cmd} {why}"));
    let by_sub = |reads: &[&str], writes: &[&str]| {
        if reads.contains(&sub.as_str()) {
            Class::Read
        } else if writes.contains(&sub.as_str()) {
            Class::Write
        } else {
            Class::Blocked(format!("{cmd} {sub} 是运维命令，这里不执行，请用 redis-cli"))
        }
    };
    match cmd.as_str() {
        "" => Class::Blocked("命令是空的".into()),
        "FLUSHALL" | "FLUSHDB" => blocked("会清空整个库，这里不执行，请用 redis-cli"),
        "KEYS" => blocked("会卡住整台 Redis，请用左边的搜索框（分批扫描）"),
        "SHUTDOWN" | "DEBUG" | "MONITOR" | "SYNC" | "PSYNC" | "REPLICAOF" | "SLAVEOF" | "FAILOVER"
        | "MODULE" | "SWAPDB" | "MIGRATE" | "SAVE" | "BGSAVE" | "BGREWRITEAOF" => {
            blocked("是运维命令，这里不执行，请用 redis-cli")
        }
        "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "UNSUBSCRIBE" | "PUNSUBSCRIBE" | "SUNSUBSCRIBE" => {
            blocked("会一直占着连接，这里不支持发布订阅")
        }
        "SELECT" => blocked("不在这里用：切库请用顶部的库号下拉"),
        "AUTH" | "HELLO" | "QUIT" | "RESET" | "ASKING" | "READONLY" | "READWRITE" => {
            blocked("会改动当前连接，请断开后在连接表单里改")
        }
        "MULTI" | "EXEC" | "DISCARD" | "WATCH" | "UNWATCH" => blocked("不支持：命令窗口一次执行一条，没有事务"),
        c if BLOCKING.contains(&c) => blocked("会阻塞等待，把连接卡住，这里不执行"),
        "XREAD" | "XREADGROUP" if args.iter().any(|a| a.eq_ignore_ascii_case(b"BLOCK")) => {
            blocked("带 BLOCK 会阻塞等待，把连接卡住，去掉 BLOCK 再执行")
        }
        "CONFIG" => by_sub(&["GET", "HELP"], &[]),
        "SCRIPT" => by_sub(&["EXISTS", "HELP"], &["LOAD"]),
        "FUNCTION" => by_sub(&["LIST", "STATS", "DUMP", "HELP"], &["LOAD"]),
        "CLUSTER" => by_sub(
            &["INFO", "NODES", "SLOTS", "SHARDS", "KEYSLOT", "MYID", "COUNTKEYSINSLOT", "GETKEYSINSLOT", "LINKS", "HELP"],
            &[],
        ),
        "SENTINEL" => by_sub(
            &["MASTERS", "MASTER", "REPLICAS", "SLAVES", "SENTINELS", "GET-MASTER-ADDR-BY-NAME", "CKQUORUM", "MYID", "HELP"],
            &[],
        ),
        "CLIENT" => by_sub(&["LIST", "INFO", "GETNAME", "ID", "HELP"], &[]),
        "ACL" => by_sub(&["WHOAMI", "LIST", "USERS", "CAT", "GETUSER", "LOG", "DRYRUN", "HELP"], &[]),
        "SLOWLOG" => by_sub(&["GET", "LEN", "HELP"], &["RESET"]),
        "MEMORY" => by_sub(&["USAGE", "STATS", "DOCTOR", "MALLOC-STATS", "HELP"], &["PURGE"]),
        "XREADGROUP" => Class::Write,
        c if READS.contains(&c) => Class::Read,
        _ => Class::Write,
    }
}

/// 不带键的命令：集群里发给第一个节点
const KEYLESS: &[&str] = &[
    "INFO", "PING", "ECHO", "TIME", "DBSIZE", "CLUSTER", "CONFIG", "CLIENT", "ACL", "SLOWLOG",
    "COMMAND", "ROLE", "LASTSAVE", "RANDOMKEY", "SCRIPT", "FUNCTION", "SCAN", "LATENCY", "LOLWUT",
];

/// 集群里按哪个参数算槽。多键命令只看第一个：跨槽的服务端会报 CROSSSLOT，不替它拆
fn key_index(args: &[Vec<u8>]) -> Option<usize> {
    let up = |i: usize| args.get(i).map(|a| String::from_utf8_lossy(a).to_ascii_uppercase()).unwrap_or_default();
    let cmd = up(0);
    match cmd.as_str() {
        "MEMORY" | "OBJECT" => (args.len() > 2).then_some(2),
        "EVAL" | "EVALSHA" | "EVAL_RO" | "EVALSHA_RO" | "FCALL" | "FCALL_RO" => {
            let n: usize = up(2).parse().unwrap_or(0);
            (n > 0 && args.len() > 3).then_some(3)
        }
        "XREAD" | "XREADGROUP" => args.iter().position(|a| a.eq_ignore_ascii_case(b"STREAMS")).map(|i| i + 1).filter(|&i| i < args.len()),
        c if KEYLESS.contains(&c) => None,
        _ => (args.len() > 1).then_some(1),
    }
}

/// 命令和键原样记，后面的参数只记长度：这份日志是查「谁动过哪个键」的，
/// 值里可能是 token，不往磁盘明文落
fn describe(args: &[Vec<u8>]) -> String {
    args.iter()
        .enumerate()
        .map(|(i, a)| {
            if i < 2 {
                clip(a)
            } else {
                format!("<{}字节>", a.len())
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn clip(a: &[u8]) -> String {
    String::from_utf8_lossy(a).chars().take(200).collect::<String>().replace(['\t', '\r', '\n'], " ")
}

/// 写操作记本机日志。写不进去也不拦命令——日志是事后查账用的，不是闸门
fn log_line(app: &AppHandle, p: &Params, db: i64, what: &str) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join(OPS_LOG)) else {
        return;
    };
    let line = format!(
        "{}\t{}:{}/{}\t{}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        p.host,
        p.port,
        db,
        what
    );
    let _ = f.write_all(line.as_bytes());
}

fn connect_spec(spec: Spec, db: i64, writable: bool) -> Result<RedisInner, String> {
    let o = open_all(&spec, db)?;
    Ok(RedisInner { spec, nodes: o.nodes, slots: o.slots, _tunnels: o.tunnels, db, writable })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn redis_connect(
    state: State<'_, RedisState>,
    host: String,
    port: String,
    user: String,
    password: String,
    db: i64,
    tls: bool,
    readonly: bool,
    kind: String,
    master: String,
    jump: Option<Jump>,
) -> Result<ConnectInfo, String> {
    let port: u16 = port.trim().parse().map_err(|_| "端口要填数字，如 6379".to_string())?;
    let topo = match kind.as_str() {
        "sentinel" => {
            let m = master.trim();
            if m.is_empty() {
                return Err("主节点名还没填（哨兵配置里 sentinel monitor 后面那个名字，常见 mymaster）".into());
            }
            Topo::Sentinel(m.to_string())
        }
        "cluster" => Topo::Cluster,
        _ => Topo::Single,
    };
    let spec = Spec {
        params: Params { host: host.trim().to_string(), port, user: user.trim().to_string(), password, tls },
        topo,
        jump,
    };
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let kind = match spec.topo {
            Topo::Single => "single",
            Topo::Sentinel(_) => "sentinel",
            Topo::Cluster => "cluster",
        };
        // 旧连接先放掉：它的跳板机转发还占着 ssh 进程
        *lock(&slot)? = None;
        let mut inner = connect_spec(spec, db, !readonly)?;
        let server: String = run(&mut inner, true, Route::Any, |c| redis::cmd("INFO").arg("server").query(c))?;
        // 云上托管的 Redis 常把 CONFIG 禁掉，拿不到就按默认 16 个库
        let db_count = if inner.slots.is_empty() {
            redis::cmd("CONFIG")
                .arg("GET")
                .arg("databases")
                .query::<Vec<String>>(&mut inner.nodes[0].con)
                .ok()
                .and_then(|v| v.get(1).and_then(|n| n.parse().ok()))
                .unwrap_or(16)
        } else {
            1
        };
        let dbs = keyspace(&mut inner)?;
        let info = ConnectInfo {
            version: info_field(&server, "redis_version").unwrap_or_default(),
            mode: info_field(&server, "redis_mode").unwrap_or_else(|| "standalone".into()),
            kind: kind.into(),
            nodes: if kind == "single" { Vec::new() } else { inner.nodes.iter().map(|n| n.addr.clone()).collect() },
            db_count,
            dbs,
            writable: inner.writable,
        };
        *lock(&slot)? = Some(inner);
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn redis_disconnect(state: State<'_, RedisState>) -> Result<(), String> {
    *lock(&state.inner)? = None;
    Ok(())
}

/// 切库：SELECT 只对当前连接生效，记下库号，断线重连时才回得到同一个库
#[tauri::command]
pub async fn redis_select(state: State<'_, RedisState>, db: i64) -> Result<(), String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = lock(&slot)?;
        let inner = g.as_mut().ok_or(NOT_CONNECTED)?;
        if !inner.slots.is_empty() {
            return Err("集群只有 0 号库".into());
        }
        run(inner, true, Route::Any, |c| redis::cmd("SELECT").arg(db).query::<()>(c))?;
        inner.db = db;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn redis_dbs(state: State<'_, RedisState>) -> Result<Vec<DbKeys>, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = lock(&slot)?;
        keyspace(g.as_mut().ok_or(NOT_CONNECTED)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 生产连接「临时允许写入」。断开即失效：下次连接按 readonly 重新算
#[tauri::command]
pub async fn redis_set_writable(state: State<'_, RedisState>, writable: bool) -> Result<(), String> {
    let mut g = lock(&state.inner)?;
    g.as_mut().ok_or(NOT_CONNECTED)?.writable = writable;
    Ok(())
}

/// 一律 SCAN，不用 KEYS：KEYS 在大库上会把整台 Redis 卡住几秒，线上就是事故
#[tauri::command]
pub async fn redis_scan(
    state: State<'_, RedisState>,
    cursor: String,
    pattern: String,
    count: u32,
) -> Result<ScanPage, String> {
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = lock(&slot)?;
        scan_page(g.as_mut().ok_or(NOT_CONNECTED)?, &cursor, &pattern, count)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 游标：单机是纯数字，集群是「节点下标:游标」
fn parse_cursor(c: &str) -> (usize, u64) {
    match c.trim().split_once(':') {
        Some((n, c)) => (n.parse().unwrap_or(0), c.parse().unwrap_or(0)),
        None => (0, c.trim().parse().unwrap_or(0)),
    }
}

fn scan_page(inner: &mut RedisInner, cursor: &str, pattern: &str, count: u32) -> Result<ScanPage, String> {
    let want = count.clamp(10, 5000) as usize;
    let pat = if pattern.trim().is_empty() { "*" } else { pattern };
    let (mut node, mut cur) = parse_cursor(cursor);
    let start = Instant::now();
    let mut keys: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut done = false;
    loop {
        if node >= inner.nodes.len() {
            done = true;
            break;
        }
        let (next, batch): (u64, Vec<Vec<u8>>) = run(inner, true, Route::Node(node), |c| {
            redis::cmd("SCAN").arg(cur).arg("MATCH").arg(pat).arg("COUNT").arg(want.max(100)).query(c)
        })?;
        keys.extend(batch.into_iter().map(|k| (node, k)));
        if next == 0 {
            // 这个节点扫完了，接着下一个节点从头扫
            node += 1;
            cur = 0;
            if node >= inner.nodes.len() {
                done = true;
                break;
            }
        } else {
            cur = next;
        }
        if keys.len() >= want || start.elapsed() > Duration::from_millis(SCAN_BUDGET_MS) {
            break;
        }
    }
    // TYPE 要发到键所在的节点，按节点分组各走一个 pipeline
    let mut types = vec![String::new(); keys.len()];
    for n in 0..inner.nodes.len() {
        let idx: Vec<usize> = (0..keys.len()).filter(|&i| keys[i].0 == n).collect();
        if idx.is_empty() {
            continue;
        }
        let got: Vec<String> = run(inner, true, Route::Node(n), |c| {
            let mut p = redis::pipe();
            for &i in &idx {
                p.cmd("TYPE").arg(keys[i].1.as_slice());
            }
            p.query(c)
        })?;
        for (&i, t) in idx.iter().zip(got) {
            types[i] = t;
        }
    }
    let cursor = if done {
        "0".to_string()
    } else if inner.slots.is_empty() {
        cur.to_string()
    } else {
        format!("{node}:{cur}")
    };
    Ok(ScanPage {
        cursor,
        keys: keys.into_iter().zip(types).map(|((_, k), t)| KeyRow { k: B64.encode(k), t }).collect(),
    })
}

/// 执行一条命令。界面上的改值、删键也都走这里，所以只读和拦截规则只有一处
#[tauri::command]
pub async fn redis_exec(app: AppHandle, state: State<'_, RedisState>, args: Vec<String>) -> Result<Reply, String> {
    let raw = args
        .iter()
        .map(|a| B64.decode(a).map_err(|_| "参数编码不对".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = lock(&slot)?;
        let inner = g.as_mut().ok_or(NOT_CONNECTED)?;
        exec_args(inner, &raw, |p, db| log_line(&app, p, db, &describe(&raw)))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn exec_args(inner: &mut RedisInner, raw: &[Vec<u8>], on_write: impl FnOnce(&Params, i64)) -> Result<Reply, String> {
    let class = classify(raw);
    match class {
        Class::Blocked(why) => return Err(why),
        Class::Write if !inner.writable => return Err(READONLY.into()),
        _ => {}
    }
    let write = class == Class::Write;
    if write {
        on_write(&inner.spec.params, inner.db);
    }
    let mut c = redis::Cmd::new();
    for a in raw {
        c.arg(a.as_slice());
    }
    let route = match key_index(raw) {
        Some(i) => Route::Key(&raw[i]),
        None => Route::Any,
    };
    run(inner, !write, route, |con| c.query::<Value>(con)).map(to_reply)
}

/// 按前缀批量删：逐个节点 SCAN 匹配的键，每批用 pipeline 逐个 UNLINK。
/// 不合成一条多键 UNLINK：集群里跨槽会报 CROSSSLOT
#[tauri::command]
pub async fn redis_delete_matching(app: AppHandle, state: State<'_, RedisState>, pattern: String) -> Result<DeleteResult, String> {
    let pat = B64.decode(&pattern).map_err(|_| "参数编码不对".to_string())?;
    let slot = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = lock(&slot)?;
        let inner = g.as_mut().ok_or(NOT_CONNECTED)?;
        let r = delete_matching(inner, &pat);
        let what = match &r {
            Ok(d) => format!("批量删除 {} 共 {} 个{}", clip(&pat), d.deleted, if d.more { "（未删完）" } else { "" }),
            Err(e) => format!("批量删除 {} 中途出错（可能已删掉一部分）：{e}", clip(&pat)),
        };
        if !matches!(&r, Err(e) if e == READONLY || e.starts_with("不能")) {
            log_line(&app, &inner.spec.params, inner.db, &what);
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

fn delete_matching(inner: &mut RedisInner, pattern: &[u8]) -> Result<DeleteResult, String> {
    // 全是通配符（* / ?）就是换个写法的 FLUSHDB
    if !pattern.iter().any(|b| !matches!(b, b'*' | b'?')) {
        return Err("不能按 * 删整个库，请带上前缀".into());
    }
    if !inner.writable {
        return Err(READONLY.into());
    }
    let start = Instant::now();
    let mut deleted = 0u64;
    let mut use_del = false;
    for n in 0..inner.nodes.len() {
        let mut cur = 0u64;
        loop {
            let (next, batch): (u64, Vec<Vec<u8>>) = run(inner, true, Route::Node(n), |c| {
                redis::cmd("SCAN").arg(cur).arg("MATCH").arg(pattern).arg("COUNT").arg(1000).query(c)
            })?;
            if !batch.is_empty() {
                let del = |c: &mut Connection, cmd: &str| {
                    let mut p = redis::pipe();
                    for k in &batch {
                        p.cmd(cmd).arg(k.as_slice());
                    }
                    p.query::<Vec<i64>>(c)
                };
                let got = match run(inner, false, Route::Node(n), |c| del(c, if use_del { "DEL" } else { "UNLINK" })) {
                    Ok(v) => v,
                    // UNLINK 是 4.0 才有的（不阻塞删大键），老版本退回 DEL
                    Err(e) if !use_del && e.to_lowercase().contains("unknown command") => {
                        use_del = true;
                        run(inner, false, Route::Node(n), |c| del(c, "DEL"))?
                    }
                    Err(e) => return Err(e),
                };
                deleted += got.iter().sum::<i64>().max(0) as u64;
            }
            cur = next;
            if cur == 0 {
                break;
            }
            if deleted >= DELETE_CAP || start.elapsed() > Duration::from_secs(DELETE_BUDGET_SECS) {
                return Ok(DeleteResult { deleted, more: true });
            }
        }
    }
    Ok(DeleteResult { deleted, more: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cls(line: &str) -> Class {
        let args: Vec<Vec<u8>> = line.split_whitespace().map(|s| s.as_bytes().to_vec()).collect();
        classify(&args)
    }

    fn words(line: &str) -> Vec<Vec<u8>> {
        line.split_whitespace().map(|x| x.as_bytes().to_vec()).collect()
    }

    #[test]
    fn 清库和_keys_任何环境都拦() {
        assert!(matches!(cls("flushall"), Class::Blocked(_)));
        assert!(matches!(cls("FLUSHDB ASYNC"), Class::Blocked(_)));
        assert!(matches!(cls("keys *"), Class::Blocked(_)));
        assert!(matches!(cls("config set maxmemory 1"), Class::Blocked(_)));
        assert!(matches!(cls("script flush"), Class::Blocked(_)));
        assert!(matches!(cls("cluster reset"), Class::Blocked(_)));
        assert!(matches!(cls("sentinel failover mymaster"), Class::Blocked(_)));
        assert!(matches!(cls("asking"), Class::Blocked(_)));
    }

    #[test]
    fn 会卡住连接的命令拦掉() {
        assert!(matches!(cls("blpop q 0"), Class::Blocked(_)));
        assert!(matches!(cls("subscribe ch"), Class::Blocked(_)));
        assert!(matches!(cls("XREAD BLOCK 0 STREAMS s $"), Class::Blocked(_)));
        assert_eq!(cls("XREAD COUNT 10 STREAMS s 0"), Class::Read);
        assert!(matches!(cls("select 3"), Class::Blocked(_)));
    }

    #[test]
    fn 读命令认得出_子命令按第二个词判() {
        assert_eq!(cls("get a"), Class::Read);
        assert_eq!(cls("HGETALL user:1"), Class::Read);
        assert_eq!(cls("config get databases"), Class::Read);
        assert_eq!(cls("memory usage k"), Class::Read);
        assert_eq!(cls("memory purge"), Class::Write);
        assert_eq!(cls("slowlog reset"), Class::Write);
        assert_eq!(cls("sentinel masters"), Class::Read);
    }

    #[test]
    fn 没见过的命令当写_只读连接不放行() {
        assert_eq!(cls("set a 1"), Class::Write);
        assert_eq!(cls("del a"), Class::Write);
        assert_eq!(cls("JSON.SET doc $ 1"), Class::Write);
        assert_eq!(cls("eval \"return 1\" 0"), Class::Write);
    }

    #[test]
    fn 写日志只记命令和键_值只记长度() {
        let args = vec![b"SET".to_vec(), b"token:1".to_vec(), b"secret-value".to_vec()];
        assert_eq!(describe(&args), "SET token:1 <12字节>");
    }

    #[test]
    fn keyspace_解析每个库的键数() {
        let info = "# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0\r\ndb3:keys=5,expires=0,avg_ttl=0\r\n";
        assert_eq!(parse_keyspace(info), vec![DbKeys { db: 0, keys: 12 }, DbKeys { db: 3, keys: 5 }]);
        assert_eq!(info_field("# Server\r\nredis_version:7.2.4\r\n", "redis_version").as_deref(), Some("7.2.4"));
    }

    #[test]
    fn 集群算槽_和_redis_官方一致() {
        // 官方规范里的校验值：CRC16("123456789") = 0x31C3
        assert_eq!(crc16(b"123456789"), 0x31c3);
        // redis-cli CLUSTER KEYSLOT foo = 12182
        assert_eq!(key_slot(b"foo"), 12182);
        assert_eq!(key_slot(b"{user1000}.following"), key_slot(b"{user1000}.followers"));
        assert_eq!(key_slot(b"{user1000}.following"), key_slot(b"user1000"));
        // 空的 {} 不算 hash tag，整个键都参与计算
        assert_eq!(key_slot(b"foo{}{bar}"), crc16(b"foo{}{bar}") % 16384);
    }

    #[test]
    fn 重定向从报错文字里认出来() {
        assert_eq!(redirect("MOVED 3999 127.0.0.1:6381"), Some((false, "127.0.0.1:6381".into())));
        assert_eq!(redirect("Moved: 3999 10.0.0.2:7001"), Some((false, "10.0.0.2:7001".into())));
        assert_eq!(redirect("An error was signalled by the server - Ask: 12 10.0.0.3:7002"), Some((true, "10.0.0.3:7002".into())));
        assert_eq!(redirect("ASK 12 [::1]:7002"), Some((true, "[::1]:7002".into())));
        assert_eq!(redirect("WRONGTYPE Operation against a key holding the wrong kind of value"), None);
        assert_eq!(redirect("ERR please ask 3 times"), None);
    }

    #[test]
    fn 主机栏可以填多个_可带端口() {
        assert_eq!(
            parse_hosts(" 10.0.0.1, 10.0.0.2:26380 ,[::1]:7000, ::1 ", 26379),
            vec![
                ("10.0.0.1".to_string(), 26379),
                ("10.0.0.2".to_string(), 26380),
                ("::1".to_string(), 7000),
                ("::1".to_string(), 26379)
            ]
        );
        assert!(parse_hosts(" , ", 6379).is_empty());
        assert_eq!(addr_of("::1", 7000), "[::1]:7000");
        assert_eq!(split_addr("[::1]:7000"), Some(("::1".into(), 7000)));
    }

    #[test]
    fn 集群槽位表_空地址用种子主机() {
        let node = |ip: &str, port: i64| Value::Array(vec![Value::BulkString(ip.as_bytes().to_vec()), Value::Int(port)]);
        let v = Value::Array(vec![
            Value::Array(vec![Value::Int(0), Value::Int(5460), node("10.0.0.1", 7001), node("10.0.0.9", 7004)]),
            Value::Array(vec![Value::Int(5461), Value::Int(16383), node("", 7002)]),
        ]);
        assert_eq!(
            parse_slots(&v, "seed").unwrap(),
            vec![(0, 5460, "10.0.0.1:7001".into()), (5461, 16383, "seed:7002".into())]
        );
        assert!(parse_slots(&Value::Array(vec![]), "seed").is_err());
    }

    #[test]
    fn 集群按哪个参数路由() {
        assert_eq!(key_index(&words("GET a")), Some(1));
        assert_eq!(key_index(&words("MEMORY USAGE a")), Some(2));
        assert_eq!(key_index(&words("EVAL x 1 k v")), Some(3));
        assert_eq!(key_index(&words("EVAL x 0")), None);
        assert_eq!(key_index(&words("XREAD COUNT 1 STREAMS s 0")), Some(4));
        assert_eq!(key_index(&words("INFO keyspace")), None);
        assert_eq!(key_index(&words("PING")), None);
        assert_eq!(parse_cursor("0"), (0, 0));
        assert_eq!(parse_cursor("2:1536"), (2, 1536));
    }

    /* ---- 真连的冒烟测试，默认跳过。没设变量就报错而不是静默通过：
     * 点名跑 --ignored 却什么都没测，比不跑还误导人 ---- */

    fn env(name: &str) -> Vec<String> {
        std::env::var(name).unwrap_or_else(|_| panic!("先 set {name}")).split('|').map(str::to_string).collect()
    }

    fn spec(host: &str, port: &str, password: &str, topo: Topo, jump: Option<Jump>) -> Spec {
        Spec {
            params: Params { host: host.into(), port: port.parse().unwrap(), user: String::new(), password: password.into(), tls: false },
            topo,
            jump,
        }
    }

    fn a(s: &str) -> Vec<Vec<u8>> {
        words(s)
    }

    /// CODENOW_REDIS_TEST=主机|端口|密码。库 0 要先灌好：1200 个 repeat_submit:*、jdk:user:1（AC ED 开头）、user:1001 哈希
    #[test]
    #[ignore]
    fn 真连_redis_扫描_读写_只读拦截() {
        let e = env("CODENOW_REDIS_TEST");
        let mut inner = connect_spec(spec(&e[0], &e[1], &e[2], Topo::Single, None), 0, false).expect("连接");

        // SCAN 分批：一页凑够 500 就交，游标接着扫能把 1200 个收齐且不重复
        let mut seen = std::collections::HashSet::new();
        let mut cur = "0".to_string();
        let mut pages = 0;
        loop {
            let p = scan_page(&mut inner, &cur, "repeat_submit:*", 500).expect("scan");
            assert!(p.keys.iter().all(|k| k.t == "string"));
            seen.extend(p.keys.into_iter().map(|k| k.k));
            pages += 1;
            cur = p.cursor;
            if cur == "0" {
                break;
            }
        }
        assert_eq!(seen.len(), 1200);
        assert!(pages >= 2, "1200 个键不该一页给完");

        // 二进制值原样回来
        let Reply::Str(b) = exec_args(&mut inner, &a("GET jdk:user:1"), |_, _| {}).unwrap() else { panic!() };
        assert_eq!(&B64.decode(b).unwrap()[..2], &[0xac, 0xed]);

        // 只读：写命令拦住且不记日志；危险命令任何时候都拦
        let mut logged = false;
        assert!(exec_args(&mut inner, &a("SET smoke:x 1"), |_, _| logged = true).unwrap_err().contains("只读"));
        assert!(!logged);
        assert!(delete_matching(&mut inner, b"smoke:*").unwrap_err().contains("只读"));
        inner.writable = true;
        assert!(exec_args(&mut inner, &a("FLUSHDB"), |_, _| {}).is_err());
        assert_eq!(exec_args(&mut inner, &a("SET smoke:x 1"), |_, _| logged = true).unwrap(), Reply::Status("OK".into()));
        assert!(logged);
        assert_eq!(exec_args(&mut inner, &a("DEL smoke:x"), |_, _| {}).unwrap(), Reply::Int(1));

        // 按前缀批量删：* 本身不让删；删完只剩别的前缀
        assert!(delete_matching(&mut inner, b"*").is_err());
        assert!(delete_matching(&mut inner, b"*?*").is_err());
        for i in 0..1500 {
            exec_args(&mut inner, &a(&format!("SET smoke:del:{i} 1")), |_, _| {}).unwrap();
        }
        let r = delete_matching(&mut inner, b"smoke:del:*").unwrap();
        assert_eq!((r.deleted, r.more), (1500, false));
        assert_eq!(scan_page(&mut inner, "0", "smoke:del:*", 100).unwrap().keys.len(), 0);
        assert_eq!(scan_page(&mut inner, "0", "repeat_submit:*", 5000).unwrap().keys.len(), 1200);

        // 服务端错误变成可读的字，不是 panic
        assert!(exec_args(&mut inner, &a("HGET jdk:user:1 f"), |_, _| {}).unwrap_err().contains("WRONGTYPE"));

        // 断线重连：CLIENT KILL 掉自己后，读命令自动重连重发
        let _ = redis::cmd("CLIENT").arg("KILL").arg("SKIPME").arg("no").arg("TYPE").arg("normal").query::<Value>(&mut inner.nodes[0].con);
        assert!(matches!(exec_args(&mut inner, &a("HGET user:1001 phone"), |_, _| {}).unwrap(), Reply::Str(_)));

        let info = keyspace(&mut inner).unwrap();
        assert!(info.iter().any(|d| d.db == 0 && d.keys > 1200));
    }

    /// CODENOW_REDIS_SENTINEL=哨兵主机|哨兵端口|主节点名|密码
    #[test]
    #[ignore]
    fn 真连_哨兵_问到主节点再连() {
        let e = env("CODENOW_REDIS_SENTINEL");
        // 第一个哨兵地址是坏的：要能跳过它问下一个
        let hosts = format!("127.0.0.1:1,{}", e[0]);
        let mut inner = connect_spec(spec(&hosts, &e[1], &e[3], Topo::Sentinel(e[2].clone()), None), 0, true).expect("连接");
        assert_eq!(inner.nodes.len(), 1);
        let Reply::Arr(role) = exec_args(&mut inner, &a("ROLE"), |_, _| {}).unwrap() else { panic!() };
        assert_eq!(role[0], Reply::Str(B64.encode("master")));
        exec_args(&mut inner, &a("SET smoke:sentinel 1"), |_, _| {}).unwrap();
        exec_args(&mut inner, &a("DEL smoke:sentinel"), |_, _| {}).unwrap();

        let bad = connect_spec(spec(&e[0], &e[1], &e[3], Topo::Sentinel("nope".into()), None), 0, true);
        assert!(bad.err().unwrap().contains("没有叫 nope 的主节点"));
    }

    /// CODENOW_REDIS_CLUSTER=任一节点主机|端口|密码
    #[test]
    #[ignore]
    fn 真连_集群_按槽路由_逐节点扫描() {
        let e = env("CODENOW_REDIS_CLUSTER");
        let mut inner = connect_spec(spec(&e[0], &e[1], &e[2], Topo::Cluster, None), 0, true).expect("连接");
        assert!(inner.nodes.len() >= 3, "测试集群要 3 个主节点");
        let _ = delete_matching(&mut inner, b"smoke:c:*");
        for i in 0..900 {
            exec_args(&mut inner, &a(&format!("SET smoke:c:{i} v{i}")), |_, _| {}).unwrap();
        }
        // 读回来每个都对：路由错了会是 MOVED 或读到 nil
        for i in [0, 1, 450, 899] {
            let Reply::Str(b) = exec_args(&mut inner, &a(&format!("GET smoke:c:{i}")), |_, _| {}).unwrap() else { panic!() };
            assert_eq!(B64.decode(b).unwrap(), format!("v{i}").into_bytes());
        }
        // 三个节点上都有键，分页扫全且不重复
        let mut seen = std::collections::HashSet::new();
        let mut cur = "0".to_string();
        loop {
            let p = scan_page(&mut inner, &cur, "smoke:c:*", 200).unwrap();
            assert!(p.keys.iter().all(|k| k.t == "string"));
            seen.extend(p.keys.into_iter().map(|k| k.k));
            cur = p.cursor;
            if cur == "0" {
                break;
            }
        }
        assert_eq!(seen.len(), 900);
        assert!(keyspace(&mut inner).unwrap()[0].keys >= 900);

        // 槽表故意搞乱：靠 MOVED 刷新后仍然读得到
        inner.slots.iter_mut().for_each(|s| *s = 0);
        for i in [3, 600] {
            let Reply::Str(b) = exec_args(&mut inner, &a(&format!("GET smoke:c:{i}")), |_, _| {}).unwrap() else { panic!() };
            assert_eq!(B64.decode(b).unwrap(), format!("v{i}").into_bytes());
        }
        assert!(inner.slots.iter().any(|&s| s != 0), "MOVED 后应刷新槽表");

        let r = delete_matching(&mut inner, b"smoke:c:*").unwrap();
        assert_eq!((r.deleted, r.more), (900, false));
        assert!(connect_spec(spec(&e[0], &e[1], &e[2], Topo::Cluster, None), 1, true).err().unwrap().contains("0 号库"));
    }

    /// CODENOW_REDIS_JUMP=跳板机主机|ssh端口|用户|密码|跳板机上看到的Redis主机|Redis端口|Redis密码|哨兵端口|主节点名
    #[test]
    #[ignore]
    fn 真连_走跳板机_单机和哨兵() {
        let e = env("CODENOW_REDIS_JUMP");
        let jump = |pw: &str| Jump { host: e[0].clone(), port: e[1].parse().unwrap(), user: e[2].clone(), password: pw.into() };

        let mut inner = connect_spec(spec(&e[4], &e[5], &e[6], Topo::Single, Some(jump(&e[3]))), 0, true).expect("走跳板机连单机");
        assert_eq!(inner._tunnels.len(), 1);
        assert!(matches!(exec_args(&mut inner, &a("PING"), |_, _| {}).unwrap(), Reply::Status(_)));
        // 断线重连要连转发一起重建
        let _ = redis::cmd("CLIENT").arg("KILL").arg("SKIPME").arg("no").arg("TYPE").arg("normal").query::<Value>(&mut inner.nodes[0].con);
        assert!(matches!(exec_args(&mut inner, &a("PING"), |_, _| {}).unwrap(), Reply::Status(_)));
        drop(inner);

        let mut inner = connect_spec(spec(&e[4], &e[7], &e[6], Topo::Sentinel(e[8].clone()), Some(jump(&e[3]))), 0, true).expect("走跳板机连哨兵");
        assert!(matches!(exec_args(&mut inner, &a("PING"), |_, _| {}).unwrap(), Reply::Status(_)));

        let bad = connect_spec(spec(&e[4], &e[5], &e[6], Topo::Single, Some(jump("wrong-pass"))), 0, true);
        assert!(bad.err().unwrap().contains("用户名或密码不对"));
        let cl = connect_spec(spec(&e[4], &e[5], &e[6], Topo::Cluster, Some(jump(&e[3]))), 0, true);
        assert!(cl.err().unwrap().contains("跳板机"));
    }
}
