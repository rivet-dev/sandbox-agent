use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use sandbox_agent::opencode_compat::OpenCodeApiDoc;
use serde_json::Value;
use utoipa::OpenApi;

fn collect_path_methods(spec: &Value) -> BTreeSet<String> {
    let mut methods = BTreeSet::new();
    let Some(paths) = spec.get("paths").and_then(|value| value.as_object()) else {
        return methods;
    };
    for (path, item) in paths {
        let Some(item) = item.as_object() else {
            continue;
        };
        for method in [
            "get", "post", "put", "patch", "delete", "options", "head", "trace",
        ] {
            if item.contains_key(method) {
                methods.insert(format!("{} {}", method.to_uppercase(), path));
            }
        }
    }
    methods
}

fn official_spec_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../resources/agent-schemas/artifacts/openapi/opencode.json")
}

#[test]
fn opencode_openapi_matches_official_paths() {
    let official_path = official_spec_path();
    let official_json = fs::read_to_string(&official_path)
        .unwrap_or_else(|err| panic!("failed to read official OpenCode spec at {official_path:?}: {err}"));
    let official: Value =
        serde_json::from_str(&official_json).expect("official OpenCode spec is not valid JSON");

    let ours = OpenCodeApiDoc::openapi();
    let ours_value = serde_json::to_value(&ours).expect("failed to serialize OpenCode OpenAPI");

    let official_methods = collect_path_methods(&official);
    let our_methods = collect_path_methods(&ours_value);

    let missing: Vec<_> = official_methods
        .difference(&our_methods)
        .cloned()
        .collect();
    let extra: Vec<_> = our_methods
        .difference(&official_methods)
        .cloned()
        .collect();

    if !missing.is_empty() || !extra.is_empty() {
        let mut message = String::new();
        if !missing.is_empty() {
            message.push_str("Missing endpoints (present in official spec, absent in ours):\n");
            for endpoint in &missing {
                message.push_str(&format!("- {endpoint}\n"));
            }
        }
        if !extra.is_empty() {
            message.push_str("Extra endpoints (present in ours, absent in official spec):\n");
            for endpoint in &extra {
                message.push_str(&format!("- {endpoint}\n"));
            }
        }
        panic!("{message}");
    }
}
