use crate::config::Secret;
use axum::http::HeaderMap;
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) struct Auth {
    bootstrap: Secret,
    consumed: AtomicBool,
    session: Secret,
    native: Secret,
    issued_at: Instant,
    pub cookie_expires_at: String,
    tickets: Mutex<HashMap<String, Instant>>,
    pub origin: String,
    pub cookie_name: String,
}

impl Auth {
    pub fn new(origin: String, environment_id: &str) -> Self {
        Self {
            bootstrap: Secret::new(super::token()),
            consumed: AtomicBool::new(false),
            session: Secret::new(super::token()),
            native: Secret::new(super::token()),
            issued_at: Instant::now(),
            cookie_expires_at: (time::OffsetDateTime::now_utc() + time::Duration::days(1))
                .format(&time::format_description::well_known::Rfc3339)
                .expect("cookie expiry"),
            tickets: Mutex::new(HashMap::new()),
            origin,
            cookie_name: format!("stardust_{}", environment_id.replace('-', "")),
        }
    }

    pub fn bootstrap(&self) -> &str {
        self.bootstrap.expose()
    }
    pub fn native(&self) -> &str {
        self.native.expose()
    }

    pub fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        headers.get("origin").is_none_or(|origin| {
            origin.to_str().is_ok_and(|origin| {
                origin == self.origin
                    || origin == "http://tauri.localhost"
                    || origin == "tauri://localhost"
            })
        })
    }

    pub fn exchange(&self, credential: &str) -> Option<String> {
        self.exchange_at(credential, Instant::now())
    }

    fn exchange_at(&self, credential: &str, at: Instant) -> Option<String> {
        if at >= self.issued_at + Duration::from_secs(300)
            || !self.bootstrap.matches(credential)
            || self
                .consumed
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return None;
        }
        Some(format!(
            "{}={}; Path=/; HttpOnly; SameSite=Strict",
            self.cookie_name,
            self.session.expose()
        ))
    }

    pub fn authorized(&self, headers: &HeaderMap) -> bool {
        self.authorized_at(headers, Instant::now())
    }

    fn authorized_at(&self, headers: &HeaderMap, at: Instant) -> bool {
        if !self.origin_allowed(headers) {
            return false;
        }
        if headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| self.native.matches(value))
        {
            return true;
        }
        if !self.consumed.load(Ordering::SeqCst)
            || at >= self.issued_at + Duration::from_secs(86400)
        {
            return false;
        }
        headers
            .get("cookie")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|cookies| {
                cookies
                    .split(';')
                    .filter_map(|cookie| cookie.trim().split_once('='))
                    .any(|(name, value)| name == self.cookie_name && self.session.matches(value))
            })
    }

    pub fn issue_ticket(&self, at: Instant) -> String {
        let mut tickets = self.tickets.lock().expect("ticket lock");
        tickets.retain(|_, expires| *expires > at);
        let value = super::token();
        tickets.insert(value.clone(), at + Duration::from_secs(30));
        value
    }

    pub fn take_ticket(&self, value: &str, at: Instant) -> bool {
        self.tickets
            .lock()
            .expect("ticket lock")
            .remove(value)
            .is_some_and(|expires| expires > at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_and_socket_tickets_are_single_use_and_cross_origin_cookies_are_rejected() {
        let auth = Auth::new("http://127.0.0.1:12345".into(), "test-environment");
        assert!(auth.exchange("invalid").is_none());
        let cookie = auth.exchange(auth.bootstrap()).unwrap();
        assert!(auth.exchange(auth.bootstrap()).is_none());
        let mut headers = HeaderMap::new();
        headers.insert("cookie", cookie.split(';').next().unwrap().parse().unwrap());
        assert!(auth.authorized(&headers));
        headers.insert("origin", "https://untrusted.example".parse().unwrap());
        assert!(!auth.authorized(&headers));
        let at = Instant::now();
        let ticket = auth.issue_ticket(at);
        assert!(auth.take_ticket(&ticket, at));
        assert!(!auth.take_ticket(&ticket, at));
        let ticket = auth.issue_ticket(at);
        assert!(!auth.take_ticket(&ticket, at + Duration::from_secs(31)));
        let expires = auth.issued_at + Duration::from_secs(86401);
        headers.remove("origin");
        assert!(!auth.authorized_at(&headers, expires));
        headers.insert(
            "authorization",
            format!("Bearer {}", auth.native()).parse().unwrap(),
        );
        assert!(auth.authorized_at(&headers, expires));
        headers.insert("origin", "https://untrusted.example".parse().unwrap());
        assert!(!auth.authorized(&headers));
        let expired = Auth::new("http://127.0.0.1:12345".into(), "expired");
        assert!(
            expired
                .exchange_at(
                    expired.bootstrap(),
                    expired.issued_at + Duration::from_secs(301)
                )
                .is_none()
        );
    }
}
