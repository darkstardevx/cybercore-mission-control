//! Bounded, outbound-only heartbeat publishing for Cybercore Mission Control.
//!
//! The connector deliberately has no listener, command parser, or remote execution surface. It
//! reads an explicit local configuration and publishes one small heartbeat at a time.

use chrono::{SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    env, fmt, fs, io,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use url::Url;

pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_CREDENTIAL_BYTES: usize = 512;
pub const MAX_RETRIES: u8 = 5;
pub const MAX_TIMEOUT_SECS: u64 = 60;
pub const MAX_INTERVAL_SECS: u64 = 24 * 60 * 60;
pub const MAX_RETRY_DELAY_MS: u64 = 5_000;

#[derive(Debug)]
pub enum ConnectorError {
    Configuration(String),
    Credential(String),
    Io(io::Error),
    Json(serde_json::Error),
    Transport(String),
    Server { status: u16 },
    PayloadTooLarge(usize),
}

impl fmt::Display for ConnectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => write!(f, "configuration error: {message}"),
            Self::Credential(message) => write!(f, "credential error: {message}"),
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Json(error) => write!(f, "JSON error: {error}"),
            Self::Transport(message) => write!(f, "transport error: {message}"),
            Self::Server { status } => write!(f, "Mission Control returned HTTP {status}"),
            Self::PayloadTooLarge(size) => {
                write!(f, "heartbeat payload is too large: {size} bytes")
            }
        }
    }
}

impl std::error::Error for ConnectorError {}

impl From<io::Error> for ConnectorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ConnectorError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub endpoint: String,
    pub agent_id: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub credential_file: Option<PathBuf>,
    #[serde(default)]
    pub credential_env: Option<String>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_interval_secs")]
    pub interval_secs: u64,
    #[serde(default = "default_max_retries")]
    pub max_retries: u8,
    #[serde(default = "default_retry_delay_ms")]
    pub retry_delay_ms: u64,
}

fn default_status() -> String {
    "online".to_owned()
}
fn default_timeout_secs() -> u64 {
    10
}
fn default_interval_secs() -> u64 {
    60
}
fn default_max_retries() -> u8 {
    3
}
fn default_retry_delay_ms() -> u64 {
    250
}

impl Config {
    pub fn from_file(path: &Path) -> Result<Self, ConnectorError> {
        let bytes = fs::read(path)?;
        let config: Self = serde_json::from_slice(&bytes)?;
        config.validate()
    }

    pub fn validate(&self) -> Result<Self, ConnectorError> {
        let url = Url::parse(&self.endpoint)
            .map_err(|_| ConnectorError::Configuration("endpoint must be a valid URL".into()))?;
        match url.scheme() {
            "https" => {}
            "http"
                if url.host_str() == Some("localhost")
                    || url.host_str() == Some("127.0.0.1")
                    || url.host_str() == Some("::1") => {}
            _ => {
                return Err(ConnectorError::Configuration(
                    "endpoint must use HTTPS (HTTP is allowed only for loopback tests)".into(),
                ))
            }
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(ConnectorError::Configuration(
                "endpoint must not contain a query or fragment".into(),
            ));
        }
        validate_agent_id(&self.agent_id)?;
        if !matches!(self.status.as_str(), "online" | "offline" | "degraded") {
            return Err(ConnectorError::Configuration(
                "status must be online, offline, or degraded".into(),
            ));
        }
        if self.timeout_secs == 0 || self.timeout_secs > MAX_TIMEOUT_SECS {
            return Err(ConnectorError::Configuration(format!(
                "timeout_secs must be 1..={MAX_TIMEOUT_SECS}"
            )));
        }
        if self.interval_secs == 0 || self.interval_secs > MAX_INTERVAL_SECS {
            return Err(ConnectorError::Configuration(format!(
                "interval_secs must be 1..={MAX_INTERVAL_SECS}"
            )));
        }
        if self.max_retries > MAX_RETRIES {
            return Err(ConnectorError::Configuration(format!(
                "max_retries must be <= {MAX_RETRIES}"
            )));
        }
        if self.retry_delay_ms > MAX_RETRY_DELAY_MS {
            return Err(ConnectorError::Configuration(format!(
                "retry_delay_ms must be <= {MAX_RETRY_DELAY_MS}"
            )));
        }
        if self.credential_file.is_some() == self.credential_env.is_some() {
            return Err(ConnectorError::Configuration(
                "configure exactly one of credential_file or credential_env".into(),
            ));
        }
        let payload = serde_json::to_vec(&self.payload)?;
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err(ConnectorError::PayloadTooLarge(payload.len()));
        }
        Ok(self.clone())
    }

    pub fn read_credential(&self) -> Result<String, ConnectorError> {
        let value = if let Some(name) = &self.credential_env {
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return Err(ConnectorError::Credential(
                    "credential_env must be a simple environment variable name".into(),
                ));
            }
            env::var(name).map_err(|_| {
                ConnectorError::Credential("credential environment variable is unavailable".into())
            })?
        } else {
            let path = self
                .credential_file
                .as_ref()
                .expect("validated credential source");
            check_credential_permissions(path)?;
            fs::read_to_string(path)?.trim().to_owned()
        };
        validate_credential(&value)?;
        Ok(value)
    }

    pub fn heartbeat_url(&self) -> Result<String, ConnectorError> {
        self.validate()?;
        let base = self.endpoint.trim_end_matches('/');
        Ok(format!("{base}/api/agents/{}/heartbeat", self.agent_id))
    }
}

fn validate_agent_id(agent_id: &str) -> Result<(), ConnectorError> {
    if agent_id.is_empty()
        || agent_id.len() > 80
        || !agent_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ConnectorError::Configuration(
            "agent_id must contain only ASCII letters, digits, '_' or '-'".into(),
        ));
    }
    Ok(())
}

fn validate_credential(value: &str) -> Result<(), ConnectorError> {
    if value.len() > MAX_CREDENTIAL_BYTES
        || !value.starts_with("mc_")
        || value.len() < 8
        || value
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(ConnectorError::Credential("credential is malformed".into()));
    }
    Ok(())
}

#[cfg(unix)]
fn check_credential_permissions(path: &Path) -> Result<(), ConnectorError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(ConnectorError::Credential(
            "credential file permissions must be owner-only".into(),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_credential_permissions(path: &Path) -> Result<(), ConnectorError> {
    fs::metadata(path).map(|_| ()).map_err(ConnectorError::Io)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Heartbeat {
    pub nonce: String,
    pub observed_at: String,
    pub status: String,
    pub payload: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeartbeatResult {
    pub heartbeat_id: Option<String>,
    pub observed_at: String,
    pub attempts: u8,
}

pub struct Connector {
    config: Config,
    credential: String,
    agent: ureq::Agent,
}

impl Connector {
    pub fn new(config: Config) -> Result<Self, ConnectorError> {
        let config = config.validate()?;
        let credential = config.read_credential()?;
        Self::with_credential(config, credential)
    }

    pub fn with_credential(config: Config, credential: String) -> Result<Self, ConnectorError> {
        let config = config.validate()?;
        validate_credential(&credential)?;
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(config.timeout_secs)))
            .max_redirects(0)
            .build()
            .new_agent();
        Ok(Self {
            config,
            credential,
            agent,
        })
    }

    pub fn heartbeat(&self) -> Heartbeat {
        Heartbeat {
            nonce: nonce(),
            observed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            status: self.config.status.clone(),
            payload: self.config.payload.clone(),
        }
    }

    pub fn send_once(&self) -> Result<HeartbeatResult, ConnectorError> {
        let heartbeat = self.heartbeat();
        let body = serde_json::to_vec(&heartbeat)?;
        if body.len() > MAX_PAYLOAD_BYTES {
            return Err(ConnectorError::PayloadTooLarge(body.len()));
        }
        let url = self.config.heartbeat_url()?;
        let attempts = self.config.max_retries.saturating_add(1);
        let mut last_error = None;
        for attempt in 1..=attempts {
            match self.send_body(&url, &body) {
                Ok(heartbeat_id) => {
                    return Ok(HeartbeatResult {
                        heartbeat_id,
                        observed_at: heartbeat.observed_at,
                        attempts: attempt,
                    })
                }
                Err(error) if attempt < attempts && is_retryable(&error) => {
                    last_error = Some(error);
                    let delay = self
                        .config
                        .retry_delay_ms
                        .saturating_mul(1_u64 << (attempt - 1));
                    thread::sleep(Duration::from_millis(delay.min(MAX_RETRY_DELAY_MS)));
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error.expect("attempts is always non-zero"))
    }

    pub fn run_periodic<F>(&self, mut on_success: F) -> Result<(), ConnectorError>
    where
        F: FnMut(&HeartbeatResult),
    {
        self.run_periodic_until(&mut on_success, || false)
    }

    /// Publish until the caller requests a stop. The wait is sliced into 100 ms intervals so a
    /// service can shut down promptly without an unbounded sleep.
    pub fn run_periodic_until<F, S>(
        &self,
        mut on_success: F,
        mut should_stop: S,
    ) -> Result<(), ConnectorError>
    where
        F: FnMut(&HeartbeatResult),
        S: FnMut() -> bool,
    {
        loop {
            if should_stop() {
                return Ok(());
            }
            let result = self.send_once()?;
            on_success(&result);
            let slices = self.config.interval_secs.saturating_mul(10);
            for _ in 0..slices {
                if should_stop() {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    fn send_body(&self, url: &str, body: &[u8]) -> Result<Option<String>, ConnectorError> {
        let response = self
            .agent
            .post(url)
            .header("authorization", format!("Bearer {}", self.credential))
            .header("content-type", "application/json")
            .send(body)
            .map_err(|error| match error {
                ureq::Error::StatusCode(status) => ConnectorError::Server { status },
                other => ConnectorError::Transport(sanitize_transport_error(&other.to_string())),
            })?;
        let text = response.into_body().read_to_string().map_err(|error| {
            ConnectorError::Transport(sanitize_transport_error(&error.to_string()))
        })?;
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            ConnectorError::Transport("Mission Control returned invalid JSON".into())
        })?;
        Ok(value
            .get("heartbeat_id")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }
}

fn sanitize_transport_error(message: &str) -> String {
    message.chars().take(200).collect()
}

fn is_retryable(error: &ConnectorError) -> bool {
    match error {
        ConnectorError::Server { status } => {
            *status == 408 || *status == 425 || *status == 429 || *status >= 500
        }
        ConnectorError::Transport(_) => true,
        _ => false,
    }
}

pub fn nonce() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(35);
    value.push_str("cybercore-");
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    fn config(endpoint: String) -> Config {
        Config {
            endpoint,
            agent_id: "agt_test".into(),
            status: "online".into(),
            payload: Map::from_iter([(String::from("platform"), Value::String("test".into()))]),
            credential_file: None,
            credential_env: Some("TEST_CYBERCORE_CREDENTIAL".into()),
            timeout_secs: 2,
            interval_secs: 1,
            max_retries: 0,
            retry_delay_ms: 0,
        }
    }

    type CapturedRequests = Arc<Mutex<Vec<Vec<u8>>>>;

    fn server(statuses: Vec<u16>) -> (String, CapturedRequests, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let handle = std::thread::spawn(move || {
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut data = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    data.extend_from_slice(&buffer[..count]);
                    if let Some(header_end) = data
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .map(|position| position + 4)
                    {
                        let headers = String::from_utf8_lossy(&data[..header_end]);
                        let body_length = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if data.len() >= header_end + body_length {
                            break;
                        }
                    }
                }
                captured.lock().unwrap().push(data);
                let response = if status == 202 {
                    r#"{"accepted":true,"heartbeat_id":"hb_test"}"#
                } else {
                    r#"{"error":"retry"}"#
                };
                let reply = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{response}", response.len());
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        (address, requests, handle)
    }

    #[test]
    fn validates_https_and_bounds() {
        let mut value = config("http://example.test".into());
        assert!(value.validate().is_err());
        value.endpoint = "http://127.0.0.1:1234".into();
        value.max_retries = MAX_RETRIES + 1;
        assert!(value.validate().is_err());
    }

    #[test]
    fn nonce_is_unique_and_prefixed() {
        assert_ne!(nonce(), nonce());
        assert!(nonce().starts_with("cybercore-"));
    }

    #[test]
    fn sends_bounded_authenticated_heartbeat() {
        let (endpoint, requests, handle) = server(vec![202]);
        let connector =
            Connector::with_credential(config(endpoint), "mc_testcredential".into()).unwrap();
        let result = connector.send_once().unwrap();
        assert_eq!(result.heartbeat_id.as_deref(), Some("hb_test"));
        handle.join().unwrap();
        let request = String::from_utf8(requests.lock().unwrap()[0].clone()).unwrap();
        assert!(request.contains("authorization: Bearer mc_testcredential"));
        assert!(request.contains("/api/agents/agt_test/heartbeat"));
        assert!(request.contains("\"nonce\""));
        assert!(!request.contains("execution"));
    }

    #[test]
    fn retries_transient_responses_with_bounded_attempts() {
        let (endpoint, requests, handle) = server(vec![503, 202]);
        let mut cfg = config(endpoint);
        cfg.max_retries = 1;
        cfg.retry_delay_ms = 0;
        let connector = Connector::with_credential(cfg, "mc_testcredential".into()).unwrap();
        let result = connector.send_once().unwrap();
        assert_eq!(result.attempts, 2);
        handle.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
    }

    #[test]
    fn periodic_mode_stops_between_bounded_wait_slices() {
        let (endpoint, _requests, handle) = server(vec![202]);
        let mut cfg = config(endpoint);
        cfg.interval_secs = 60;
        let connector = Connector::with_credential(cfg, "mc_testcredential".into()).unwrap();
        let mut checks = 0;
        connector
            .run_periodic_until(
                |_| {},
                || {
                    checks += 1;
                    checks > 1
                },
            )
            .unwrap();
        handle.join().unwrap();
    }

    #[test]
    fn does_not_retry_authentication_failures() {
        let (endpoint, requests, handle) = server(vec![401]);
        let mut cfg = config(endpoint);
        cfg.max_retries = 3;
        cfg.retry_delay_ms = 0;
        let connector = Connector::with_credential(cfg, "mc_testcredential".into()).unwrap();
        assert!(matches!(
            connector.send_once(),
            Err(ConnectorError::Server { status: 401 })
        ));
        handle.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn malformed_credentials_are_rejected_without_logging() {
        let result = Connector::with_credential(
            config("http://127.0.0.1:1234".into()),
            "secret-value".into(),
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("malformed credential must fail"),
        };
        assert!(matches!(error, ConnectorError::Credential(_)));
        assert!(!error.to_string().contains("secret-value"));
    }
}
