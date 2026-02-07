use std::env;

use reqwest::blocking::ClientBuilder as BlockingClientBuilder;
use reqwest::ClientBuilder;

const NO_SYSTEM_PROXY_ENV: &str = "SANDBOX_AGENT_NO_SYSTEM_PROXY";

fn disable_system_proxy() -> bool {
    env::var(NO_SYSTEM_PROXY_ENV)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

pub fn client_builder() -> ClientBuilder {
    let builder = reqwest::Client::builder();
    if disable_system_proxy() {
        builder.no_proxy()
    } else {
        builder
    }
}

pub fn blocking_client_builder() -> BlockingClientBuilder {
    let builder = reqwest::blocking::Client::builder();
    if disable_system_proxy() {
        builder.no_proxy()
    } else {
        builder
    }
}
