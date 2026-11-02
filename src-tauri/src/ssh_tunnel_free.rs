//! 开源版（不开 pro）的跳板机占位：类型跟 pro/src-tauri/ssh_tunnel.rs 一致，
//! redis_client 不用分两套写；真要走跳板机就报专业版。

use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[allow(dead_code)]
pub struct Jump {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

pub struct Tunnel {
    pub port: u16,
}

pub fn open(_j: &Jump, _target_host: &str, _target_port: u16) -> Result<Tunnel, String> {
    Err("走跳板机是专业版功能，开源版请直连 Redis".into())
}
