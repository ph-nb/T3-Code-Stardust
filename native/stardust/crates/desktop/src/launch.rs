use url::Url;

#[derive(Debug, PartialEq)]
pub enum LaunchMode {
    Local,
    Remote(Url),
    Embedded,
}

pub fn launch_mode(address: Option<&str>, embedded: bool) -> Result<LaunchMode, &'static str> {
    if let Some(address) = address {
        let url = Url::parse(address).map_err(|_| "invalid desktop URL")?;
        let trusted_loopback = url
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "[::1]"));
        if !(url.scheme() == "https" || url.scheme() == "http" && trusted_loopback)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("desktop URL requires HTTPS or loopback HTTP without embedded credentials");
        }
        return Ok(LaunchMode::Remote(url));
    }
    Ok(if embedded {
        LaunchMode::Embedded
    } else {
        LaunchMode::Local
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_install_starts_the_local_runtime_without_backend_configuration() {
        assert_eq!(launch_mode(None, false).unwrap(), LaunchMode::Local);
        assert_eq!(launch_mode(None, true).unwrap(), LaunchMode::Embedded);
        assert!(matches!(
            launch_mode(Some("https://stardust.example.com"), true).unwrap(),
            LaunchMode::Remote(_)
        ));
    }

    #[test]
    fn remote_navigation_requires_https_or_loopback_without_embedded_credentials() {
        for address in [
            "https://stardust.example.com/pair#fixture",
            "http://127.0.0.1:3773",
            "http://localhost:3773",
            "http://[::1]:3773",
        ] {
            assert!(launch_mode(Some(address), false).is_ok(), "{address}");
        }
        for address in [
            "",
            "http://stardust.example.com",
            "http://localhost.example.com",
            "https://username:password@stardust.example.com",
            "file:///C:/private.txt",
            "javascript:alert(1)",
            "ws://127.0.0.1:3773",
        ] {
            assert!(launch_mode(Some(address), false).is_err(), "{address}");
        }
    }
}
