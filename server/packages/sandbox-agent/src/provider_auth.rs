use std::collections::HashMap;

use sandbox_agent_agent_management::credentials::{AuthType, ExtractedCredentials, ProviderCredentials};
use tokio::sync::Mutex;

#[derive(Clone, Debug)]
pub enum ProviderAuth {
    Api { key: String },
    OAuth { access: String },
    WellKnown { key: String, token: String },
}

#[derive(Clone, Debug)]
pub enum ProviderAuthOverride {
    Set(ProviderAuth),
    Remove,
}

#[derive(Debug)]
pub struct ProviderAuthStore {
    overrides: Mutex<HashMap<String, ProviderAuthOverride>>,
}

impl ProviderAuthStore {
    pub fn new() -> Self {
        Self {
            overrides: Mutex::new(HashMap::new()),
        }
    }

    pub async fn set(&self, provider_id: &str, auth: ProviderAuth) {
        let provider = normalize_provider_id(provider_id);
        let mut overrides = self.overrides.lock().await;
        overrides.insert(provider, ProviderAuthOverride::Set(auth));
    }

    pub async fn remove(&self, provider_id: &str) {
        let provider = normalize_provider_id(provider_id);
        let mut overrides = self.overrides.lock().await;
        overrides.insert(provider, ProviderAuthOverride::Remove);
    }

    pub async fn snapshot(&self) -> HashMap<String, ProviderAuthOverride> {
        self.overrides.lock().await.clone()
    }

    pub fn apply_overrides(
        mut credentials: ExtractedCredentials,
        overrides: HashMap<String, ProviderAuthOverride>,
    ) -> ExtractedCredentials {
        for (provider, override_value) in overrides {
            match override_value {
                ProviderAuthOverride::Set(auth) => {
                    let cred = provider_credentials(&provider, &auth);
                    match provider.as_str() {
                        "anthropic" => credentials.anthropic = Some(cred),
                        "openai" => credentials.openai = Some(cred),
                        _ => {
                            credentials.other.insert(provider.clone(), cred);
                        }
                    }
                }
                ProviderAuthOverride::Remove => match provider.as_str() {
                    "anthropic" => credentials.anthropic = None,
                    "openai" => credentials.openai = None,
                    _ => {
                        credentials.other.remove(&provider);
                    }
                },
            }
        }
        credentials
    }

    pub fn connected_providers(credentials: &ExtractedCredentials) -> Vec<String> {
        let mut connected = Vec::new();
        if let Some(cred) = &credentials.anthropic {
            connected.push(cred.provider.clone());
        }
        if let Some(cred) = &credentials.openai {
            connected.push(cred.provider.clone());
        }
        for key in credentials.other.keys() {
            connected.push(key.clone());
        }
        connected.sort();
        connected.dedup();
        connected
    }
}

fn provider_credentials(provider: &str, auth: &ProviderAuth) -> ProviderCredentials {
    ProviderCredentials {
        api_key: auth_key(auth).to_string(),
        source: "opencode".to_string(),
        auth_type: auth_type(auth),
        provider: provider.to_string(),
    }
}

fn auth_type(auth: &ProviderAuth) -> AuthType {
    match auth {
        ProviderAuth::Api { .. } => AuthType::ApiKey,
        ProviderAuth::OAuth { .. } => AuthType::Oauth,
        ProviderAuth::WellKnown { .. } => AuthType::ApiKey,
    }
}

fn auth_key(auth: &ProviderAuth) -> &str {
    match auth {
        ProviderAuth::Api { key } => key,
        ProviderAuth::OAuth { access } => access,
        ProviderAuth::WellKnown { token, .. } => token,
    }
}

fn normalize_provider_id(provider_id: &str) -> String {
    provider_id.trim().to_ascii_lowercase()
}
