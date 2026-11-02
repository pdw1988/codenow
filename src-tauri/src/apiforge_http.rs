//! APIForge 单次 HTTP（回归 / 登录 / 试跑），绕开 WebView 的 CORS。
//!
//! 压测已经在 `apiforge_bench` 里用 reqwest 发；回归若继续走前端 `fetch`，
//! 打内网服务（如 `http://192.168.1.10:8080`）会被 CORS / 混合内容直接
//! `TypeError: Failed to fetch`，跟接口本身无关。这里给前端一条桌面 IPC，
//! 语义跟 `sendRequest` 对齐：status + 截断后的 bodyText。

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 只防失控的整表导出；调试卡要能「展开全部」看完整响应
const BODY_CAP: usize = 2_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReq {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResp {
    pub status: Option<u16>,
    pub body_text: String,
}

#[tauri::command]
pub async fn apiforge_http(req: HttpReq, timeout_ms: u64) -> Result<HttpResp, String> {
    if !(req.url.starts_with("http://") || req.url.starts_with("https://")) {
        return Err(format!("请求 URL 必须是 http(s):// 开头: {}", req.url));
    }
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| format!("方法不合法: {}", req.method))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1000)))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(b) = &req.body {
        rb = rb.body(b.clone());
    }

    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let body_text = if text.len() > BODY_CAP {
                text.chars().take(BODY_CAP).collect()
            } else {
                text
            };
            Ok(HttpResp {
                status: Some(status),
                body_text,
            })
        }
        Err(e) => {
            if e.is_timeout() {
                Err(format!("请求超时（{timeout_ms}ms）"))
            } else if e.is_connect() {
                Err(format!("连接失败：{}", short(&e)))
            } else {
                Err(format!("请求失败：{}", short(&e)))
            }
        }
    }
}

fn short(e: &reqwest::Error) -> String {
    e.to_string().chars().take(160).collect()
}
