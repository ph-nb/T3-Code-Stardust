use std::{
    fmt,
    net::SocketAddr,
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn matches(&self, candidate: &str) -> bool {
        self.0.as_bytes().ct_eq(candidate.as_bytes()).into()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid runtime configuration: {0}")]
    Invalid(&'static str),
    #[error("could not access isolated runtime state")]
    State(#[from] std::io::Error),
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub frontend_dir: Option<PathBuf>,
    pub database_url: Secret,
    pub redis_url: Option<Secret>,
    pub schema: String,
    pub token: Secret,
    pub environment_id: String,
}

pub fn validate_schema(value: &str) -> Result<(), ConfigError> {
    let mut bytes = value.bytes();
    if value.len() > 63
        || !bytes.next().is_some_and(|c| c.is_ascii_lowercase())
        || !bytes.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        || value.starts_with("pg_")
        || matches!(value, "public" | "information_schema")
    {
        return Err(ConfigError::Invalid("schema"));
    }
    Ok(())
}

pub fn validate_url(
    value: &str,
    protocols: &[&str],
    field: &'static str,
) -> Result<(), ConfigError> {
    let url = url::Url::parse(value).map_err(|_| ConfigError::Invalid(field))?;
    if !protocols.contains(&url.scheme()) || url.host_str().is_none() {
        return Err(ConfigError::Invalid(field));
    }
    Ok(())
}

pub fn initialize_state(directory: &Path) -> Result<String, ConfigError> {
    std::fs::create_dir_all(directory)?;
    let identity_path = directory.join("environment-id");
    match std::fs::read_to_string(&identity_path) {
        Ok(value) => {
            let value = value.trim();
            if value.is_empty() {
                return Err(ConfigError::Invalid("environment-id"));
            }
            return Ok(value.to_owned());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let value = Uuid::new_v4().to_string();
    use std::io::Write;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&identity_path)
    {
        Ok(mut file) => {
            file.write_all(value.as_bytes())?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return initialize_state(directory);
        }
        Err(error) => return Err(error.into()),
    }
    Ok(value)
}

impl Config {
    pub fn load_environment(listen: SocketAddr) -> Result<Self, ConfigError> {
        let required =
            |key: &'static str| std::env::var(key).map_err(|_| ConfigError::Invalid(key));
        let data_dir = PathBuf::from(required("STARDUST_STATE_DIR")?);
        let token_file = required("STARDUST_TOKEN_FILE")?;
        let token = std::fs::read_to_string(token_file)?;
        let result = Self {
            listen,
            environment_id: initialize_state(&data_dir)?,
            data_dir,
            frontend_dir: std::env::var("STARDUST_FRONTEND_DIR")
                .ok()
                .map(PathBuf::from),
            database_url: Secret::new(required("T3CODE_DATABASE_URL")?),
            redis_url: std::env::var("T3CODE_REDIS_URL").ok().map(Secret::new),
            schema: std::env::var("STARDUST_SCHEMA")
                .unwrap_or_else(|_| "stardust_rust_preview".to_owned()),
            token: Secret::new(token.trim().to_owned()),
        };
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<(), ConfigError> {
        validate_schema(&self.schema)?;
        if !self.schema.starts_with("stardust_rust_") {
            return Err(ConfigError::Invalid(
                "preview requires a stardust_rust_ schema",
            ));
        }
        if !self.listen.ip().is_loopback() {
            return Err(ConfigError::Invalid("preview listener must use loopback"));
        }
        validate_url(
            self.database_url.expose(),
            &["postgres", "postgresql"],
            "database URL",
        )?;
        if let Some(url) = &self.redis_url {
            validate_url(url.expose(), &["redis", "rediss"], "Redis URL")?;
        }
        if self.token.expose().len() < 32 {
            return Err(ConfigError::Invalid(
                "bearer token must have at least 32 characters",
            ));
        }
        if self.environment_id.is_empty() {
            return Err(ConfigError::Invalid("environment-id"));
        }
        if let Some(frontend) = &self.frontend_dir {
            let frontend = frontend.canonicalize()?;
            let data = self.data_dir.canonicalize()?;
            if data.starts_with(frontend) {
                return Err(ConfigError::Invalid(
                    "frontend directory exposes runtime state",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prevents_namespace_injection_and_redacts_credentials() {
        for value in [
            "",
            "public",
            "pg_catalog",
            "a,b",
            "a\";drop schema b",
            "UPPER",
            "1name",
        ] {
            assert!(validate_schema(value).is_err(), "{value}");
        }
        assert!(validate_schema("stardust_rust_preview").is_ok());
        let value = Secret::new("fixture-only-value-which-must-not-be-logged".into());
        assert_eq!(format!("{value:?}"), "[REDACTED]");
        assert!(value.matches(value.expose()));
        assert!(!value.matches("wrong"));
        assert_eq!(
            validate_url("not a secret URL", &["postgres"], "database URL")
                .unwrap_err()
                .to_string(),
            "invalid runtime configuration: database URL"
        );
    }
    #[test]
    fn preserves_a_persisted_environment_identity() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            initialize_state(directory.path()).unwrap(),
            initialize_state(directory.path()).unwrap()
        );
    }
}
