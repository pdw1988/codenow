//! 专业版许可码：Ed25519 验签。
//!
//! 私钥只在作者机器 `~/.tauri/chuju-license.key`，签发走 `pro/scripts/issue-license.mjs`。
//! 公钥、试用记录镜像、专业版命令闸门在 license_guard（专业版实现在 pro/，开源版是占位）。
//!
//! 码形：`CHUJU2.<payload-b64url>.<sig-b64url>`，签名对象是前两段拼起来的 UTF-8。

use crate::license_guard;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::NaiveDate;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const PREFIX: &str = "CHUJU2";
/// 用户在升级卡点「免费试用」起算，和 cache.db 同目录，清空表结构缓存不会重置。
pub const TRIAL_DAYS: i64 = 7;
const TRIAL_FILE: &str = "trial.v1.json";
/// 系统时间比记录早过这一天，当拨钟，试用作废。
const CLOCK_SLACK_DAYS: i64 = 1;
/// 见过的最晚日期，只增不减。限期码按它判到期，拨回系统时间不续命。
const SEEN_FILE: &str = "seen.v1.txt";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LicenseInfo {
    pub v: u8,
    pub kind: String,
    pub forever: bool,
    pub until: Option<String>,
    /// 签发时写进去的买家称呼，界面显示「授权给 xxx」：码被转发就挂着别人的名字。老码没有。
    pub to: Option<String>,
    pub code: String,
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

/// (forever, until, to)
fn parse_payload(raw: &str) -> Option<(bool, Option<String>, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    if v.get("v")?.as_u64()? != 1 {
        return None;
    }
    if v.get("kind")?.as_str()? != "pro" {
        return None;
    }
    let to = v
        .get("to")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().chars().take(40).collect::<String>())
        .filter(|s| !s.is_empty());
    if v.get("forever").and_then(|x| x.as_bool()) == Some(true) {
        return Some((true, None, to));
    }
    let until = v.get("until")?.as_str()?.to_string();
    if until.len() == 10
        && until.as_bytes()[4] == b'-'
        && until.as_bytes()[7] == b'-'
        && until.bytes().all(|c| c.is_ascii_digit() || c == b'-')
    {
        return Some((false, Some(until), to));
    }
    None
}

fn still_valid(forever: bool, until: &Option<String>, today: &str) -> bool {
    if forever {
        return true;
    }
    match until {
        // YYYY-MM-DD 字典序即时间序；当天仍有效
        Some(d) => d.as_str() >= today,
        None => false,
    }
}

/// `today` 为本地 `YYYY-MM-DD`。格式 / 签名 / 过期一律回 None，不说哪一位错了。
pub fn verify_code(code: &str, today: &str, pubkey: &[u8; 32]) -> Option<LicenseInfo> {
    let code = code.trim();
    let mut parts = code.split('.');
    let prefix = parts.next()?;
    let body = parts.next()?;
    let sig_b64 = parts.next()?;
    if parts.next().is_some() || prefix != PREFIX || body.is_empty() || sig_b64.is_empty() {
        return None;
    }
    let payload_raw = b64url_decode(body)?;
    let sig_bytes = b64url_decode(sig_b64)?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().ok()?;
    let vk = VerifyingKey::from_bytes(pubkey).ok()?;
    let msg = format!("{PREFIX}.{body}");
    vk.verify(msg.as_bytes(), &Signature::from_bytes(&sig_arr))
        .ok()?;
    let text = String::from_utf8(payload_raw).ok()?;
    let (forever, until, to) = parse_payload(&text)?;
    if !still_valid(forever, &until, today) {
        return None;
    }
    Some(LicenseInfo {
        v: 1,
        kind: "pro".into(),
        forever,
        until,
        to,
        code: code.to_string(),
    })
}

fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TrialInfo {
    /// 点过「免费试用」（试用标记文件存在）
    pub started: bool,
    pub active: bool,
    pub remaining_days: u32,
    pub total_days: u32,
    pub clock_tampered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrialStamp {
    first_seen: String,
    last_seen: String,
    #[serde(default)]
    voided: bool,
}

fn parse_ymd(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn days_between(from: &str, to: &str) -> Option<i64> {
    Some(parse_ymd(to)?.signed_duration_since(parse_ymd(from)?).num_days())
}

fn clock_rolled_back(today: &str, marked: &str) -> bool {
    match days_between(today, marked) {
        Some(d) => d > CLOCK_SLACK_DAYS,
        None => true,
    }
}

/// 纯计算，方便单测。`stamp` 是读盘结果；缺文件时传入 None。
pub fn eval_trial(stamp: Option<&TrialStamp>, today: &str) -> (TrialStamp, TrialInfo) {
    let mut next = match stamp {
        Some(s) if parse_ymd(&s.first_seen).is_some() && parse_ymd(&s.last_seen).is_some() => s.clone(),
        _ => TrialStamp {
            first_seen: today.to_string(),
            last_seen: today.to_string(),
            voided: false,
        },
    };

    if clock_rolled_back(today, &next.first_seen) || clock_rolled_back(today, &next.last_seen) {
        next.voided = true;
    }

    if !next.voided {
        if let Some(d) = days_between(&next.last_seen, today) {
            if d >= 0 {
                next.last_seen = today.to_string();
            }
        }
    }

    let elapsed = days_between(&next.first_seen, today).unwrap_or(TRIAL_DAYS);
    let remaining = if next.voided || elapsed < 0 {
        0
    } else {
        (TRIAL_DAYS - elapsed).max(0) as u32
    };
    let info = TrialInfo {
        started: true,
        active: remaining > 0 && !next.voided,
        remaining_days: remaining,
        total_days: TRIAL_DAYS as u32,
        clock_tampered: next.voided,
    };
    (next, info)
}

fn trial_path(dir: &Path) -> PathBuf {
    dir.join(TRIAL_FILE)
}

fn read_stamp(path: &Path) -> Option<TrialStamp> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_stamp(path: &Path, stamp: &TrialStamp) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(stamp) {
        let _ = fs::write(path, json);
    }
}

fn voided_stamp(today: &str) -> TrialStamp {
    TrialStamp {
        first_seen: today.to_string(),
        last_seen: today.to_string(),
        voided: true,
    }
}

/// 几份记录合成一份：最早的起始、最晚的「见过」、任一份作废就作废。
/// 日期写坏的那份不参与取最早 / 最晚，只看 voided。
fn merge_stamps(all: &[TrialStamp]) -> Option<TrialStamp> {
    let ok: Vec<&TrialStamp> = all
        .iter()
        .filter(|s| parse_ymd(&s.first_seen).is_some() && parse_ymd(&s.last_seen).is_some())
        .collect();
    let first = ok.iter().map(|s| s.first_seen.as_str()).min()?;
    let last = ok.iter().map(|s| s.last_seen.as_str()).max()?;
    Some(TrialStamp {
        first_seen: first.to_string(),
        last_seen: last.to_string(),
        voided: all.iter().any(|s| s.voided),
    })
}

/// 读/写 AppData 里的试用标记，`mirrors` 是 license_guard 从别处读来的副本。
/// 哪一份都没有且不是 `start` 就算没开始、不写盘；任一份在就算试用过，删主文件不重开。
/// 文件或副本坏了当作废。第二个返回值是要写回各副本的 JSON。
pub fn tick_trial(dir: Option<&Path>, today: &str, start: bool, mirrors: &[String]) -> (TrialInfo, Option<String>) {
    let not_started = TrialInfo {
        started: false,
        active: false,
        remaining_days: TRIAL_DAYS as u32,
        total_days: TRIAL_DAYS as u32,
        clock_tampered: false,
    };
    let Some(dir) = dir else {
        return (not_started, None);
    };
    let path = trial_path(dir);
    let had_file = path.exists();
    if !had_file && mirrors.is_empty() && !start {
        return (not_started, None);
    }
    let mut all: Vec<TrialStamp> = mirrors
        .iter()
        .map(|s| serde_json::from_str(s).unwrap_or_else(|_| voided_stamp(today)))
        .collect();
    if had_file {
        all.push(read_stamp(&path).unwrap_or_else(|| voided_stamp(today)));
    }
    // 有记录但一份日期都不对：当作废，不当没试过
    let merged = merge_stamps(&all).or_else(|| (!all.is_empty()).then(|| voided_stamp(today)));
    let (next, info) = eval_trial(merged.as_ref(), today);
    write_stamp(&path, &next);
    (info, serde_json::to_string(&next).ok())
}

/// 判到期用的「今天」：系统日期、记录的最晚日期、同目录文件最新修改日期三者取最晚。
/// YYYY-MM-DD 字典序即时间序。
fn pick_effective_day(today: &str, mark: Option<&str>, newest_file: Option<&str>) -> String {
    [Some(today), mark, newest_file]
        .into_iter()
        .flatten()
        .filter(|d| parse_ymd(d).is_some())
        .max()
        .unwrap_or(today)
        .to_string()
}

fn newest_file_day(dir: &Path) -> Option<String> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d").to_string())
}

/// 取有效日期并把记录推到这一天。记录被删，靠同目录 cache.db 等文件的修改日期兜底。
fn effective_today(dir: Option<&Path>, today: &str) -> String {
    let Some(dir) = dir else {
        return today.to_string();
    };
    let path = dir.join(SEEN_FILE);
    let mark = fs::read_to_string(&path).ok().map(|s| s.trim().to_string());
    let day = pick_effective_day(today, mark.as_deref(), newest_file_day(dir).as_deref());
    if mark.as_deref() != Some(day.as_str()) {
        let _ = fs::create_dir_all(dir);
        let _ = fs::write(&path, &day);
    }
    day
}

/// 验签名与到期。不联网；只写一个「见过的最晚日期」。前端 persist 许可码，每次启动再问一次。
#[tauri::command]
pub fn license_verify(app: AppHandle, code: String) -> Option<LicenseInfo> {
    let dir = app.path().app_data_dir().ok();
    let today = effective_today(dir.as_deref(), &today_local());
    let info = license_guard::pubkey().and_then(|pk| verify_code(&code, &today, &pk));
    license_guard::set_licensed(&app, info.is_some());
    info
}

const CODE_FILE: &str = "license.v1.txt";

fn code_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CODE_FILE))
}

/// 读已存的许可码。和 cache.db 同目录，开发版和安装版共用，清网页存储也不丢。
#[tauri::command]
pub fn license_code_load(app: AppHandle) -> Option<String> {
    let raw = fs::read_to_string(code_path(&app)?).ok()?;
    let code = raw.trim();
    (!code.is_empty()).then(|| code.to_string())
}

/// 存许可码；空串即删除。
#[tauri::command]
pub fn license_code_save(app: AppHandle, code: String) -> Result<(), String> {
    let path = code_path(&app).ok_or("取不到应用数据目录")?;
    let code = code.trim();
    if code.is_empty() {
        license_guard::set_licensed(&app, false);
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, code).map_err(|e| e.to_string())
}

/// 试用状态。`start` = 用户点了「免费试用」；每台机器只一轮，已开始的再点不重置。
#[tauri::command]
pub fn license_trial(app: AppHandle, start: bool) -> TrialInfo {
    let dir = app.path().app_data_dir().ok();
    let mirrors = license_guard::mirror_read(&app);
    let (info, json) = tick_trial(dir.as_deref(), &today_local(), start, &mirrors);
    if let Some(json) = json {
        license_guard::mirror_write(&app, &json);
    }
    license_guard::set_trial(&app, info.active);
    info
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};

    fn fixture() -> (SigningKey, [u8; 32]) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        (sk, pk)
    }

    fn sign_payload(sk: &SigningKey, json: &str) -> String {
        let body = URL_SAFE_NO_PAD.encode(json.as_bytes());
        let msg = format!("{PREFIX}.{body}");
        let sig = URL_SAFE_NO_PAD.encode(sk.sign(msg.as_bytes()).to_bytes());
        format!("{msg}.{sig}")
    }

    #[test]
    fn 终身码能过() {
        let (sk, pk) = fixture();
        let code = sign_payload(&sk, r#"{"v":1,"kind":"pro","forever":true}"#);
        let lic = verify_code(&code, "2026-08-30", &pk).expect("应通过");
        assert_eq!(lic.kind, "pro");
        assert!(lic.forever);
        assert_eq!(lic.until, None);
    }

    #[test]
    fn 改一位就作废() {
        let (sk, pk) = fixture();
        let code = sign_payload(&sk, r#"{"v":1,"kind":"pro","forever":true}"#);
        let mut bad = code.clone();
        bad.replace_range(bad.len() - 1.., if code.ends_with('a') { "b" } else { "a" });
        assert!(verify_code(&bad, "2026-08-30", &pk).is_none());
        assert!(verify_code("not-a-license", "2026-08-30", &pk).is_none());
        assert!(verify_code("", "2026-08-30", &pk).is_none());
        assert!(verify_code("CHUJU1.aaa.bbb", "2026-08-30", &pk).is_none());
    }

    #[test]
    fn 到期日当天有效次日无效() {
        let (sk, pk) = fixture();
        let code = sign_payload(&sk, r#"{"v":1,"kind":"pro","until":"2026-08-30"}"#);
        assert!(verify_code(&code, "2026-08-30", &pk).is_some());
        assert!(verify_code(&code, "2026-08-31", &pk).is_none());
    }

    #[test]
    fn 拨回系统时间不续命() {
        let (sk, pk) = fixture();
        let code = sign_payload(&sk, r#"{"v":1,"kind":"pro","until":"2026-08-30"}"#);
        // 见过 08-31 之后拨回 08-29：按 08-31 判，已过期
        let day = pick_effective_day("2026-08-29", Some("2026-08-31"), None);
        assert_eq!(day, "2026-08-31");
        assert!(verify_code(&code, &day, &pk).is_none());
        // 记录被删，文件修改日期兜底
        assert_eq!(pick_effective_day("2026-08-29", None, Some("2026-09-02")), "2026-09-02");
        // 记录写坏当没有；正常往前走按系统日期
        assert_eq!(pick_effective_day("2026-08-29", Some("garbage"), None), "2026-08-29");
        assert_eq!(pick_effective_day("2026-09-01", Some("2026-08-31"), Some("2026-08-20")), "2026-09-01");
    }

    #[test]
    fn 终身码不受拨钟影响() {
        let (sk, pk) = fixture();
        let code = sign_payload(&sk, r#"{"v":1,"kind":"pro","forever":true}"#);
        assert!(verify_code(&code, &pick_effective_day("2026-08-29", Some("2027-01-01"), None), &pk).is_some());
    }

    #[test]
    fn 试用七天_拨钟作废() {
        let (s, info) = eval_trial(None, "2026-10-01");
        assert!(info.active && info.remaining_days == 7);
        let (_, d7) = eval_trial(Some(&s), "2026-10-07");
        assert!(d7.active && d7.remaining_days == 1);
        let (s8, d8) = eval_trial(Some(&s), "2026-10-08");
        assert!(!d8.active);
        // 过期后拨回去不续命
        let (_, back) = eval_trial(Some(&s8), "2026-10-03");
        assert!(!back.active && back.clock_tampered);
    }

    #[test]
    fn 没点试用不起算_点了再点不重置() {
        let dir = std::env::temp_dir().join(format!("devtools-trial-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (idle, none) = tick_trial(Some(&dir), "2026-10-01", false, &[]);
        assert!(!idle.started && !idle.active && none.is_none());
        assert!(!trial_path(&dir).exists());
        assert!(tick_trial(Some(&dir), "2026-10-01", true, &[]).0.active);
        let (later, _) = tick_trial(Some(&dir), "2026-10-05", true, &[]);
        assert!(later.started && later.remaining_days == 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 删了主文件副本还在_不重开() {
        let dir = std::env::temp_dir().join(format!("devtools-trial-m-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (_, json) = tick_trial(Some(&dir), "2026-10-01", true, &[]);
        let mirror = json.expect("要写副本");
        fs::remove_file(trial_path(&dir)).unwrap();
        // 没点试用也认得试过；点了也不重新起算 7 天
        let (seen, _) = tick_trial(Some(&dir), "2026-10-03", false, &[mirror.clone()]);
        assert!(seen.started && seen.remaining_days == 5);
        fs::remove_file(trial_path(&dir)).unwrap();
        let (again, _) = tick_trial(Some(&dir), "2026-10-03", true, &[mirror.clone()]);
        assert_eq!(again.remaining_days, 5);
        fs::remove_file(trial_path(&dir)).unwrap();
        let (over, _) = tick_trial(Some(&dir), "2026-10-09", true, &[mirror]);
        assert!(!over.active);
        // 副本写坏了当作废，不当没试过
        fs::remove_file(trial_path(&dir)).unwrap();
        let (bad, _) = tick_trial(Some(&dir), "2026-10-09", true, &["x".into()]);
        assert!(!bad.active);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 几份记录取最早起始() {
        let a = TrialStamp { first_seen: "2026-10-05".into(), last_seen: "2026-10-05".into(), voided: false };
        let b = TrialStamp { first_seen: "2026-10-01".into(), last_seen: "2026-10-02".into(), voided: false };
        let m = merge_stamps(&[a, b]).unwrap();
        assert_eq!((m.first_seen.as_str(), m.last_seen.as_str(), m.voided), ("2026-10-01", "2026-10-05", false));
    }

    #[test]
    fn 码里的买家名读得出_老码没有() {
        let (sk, pk) = fixture();
        let named = sign_payload(&sk, r#"{"v":1,"kind":"pro","forever":true,"to":" 张三 "}"#);
        assert_eq!(verify_code(&named, "2026-08-30", &pk).unwrap().to.as_deref(), Some("张三"));
        let old = sign_payload(&sk, r#"{"v":1,"kind":"pro","forever":true}"#);
        assert_eq!(verify_code(&old, "2026-08-30", &pk).unwrap().to, None);
    }
}
