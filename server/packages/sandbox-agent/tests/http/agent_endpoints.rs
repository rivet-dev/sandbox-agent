// Agent-specific HTTP endpoints live here; session-related snapshots are in tests/sessions/.
include!("../common/http.rs");

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_snapshots() {
    let token = "test-token";
    let app = TestApp::new_with_auth(AuthConfig::with_token(token.to_string()));

    let (status, payload) = send_json(&app.app, Method::GET, "/v1/health", None).await;
    assert_eq!(status, StatusCode::OK, "health should be public");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_health_public", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": normalize_health(&payload),
        }));
    });

    let (status, payload) = send_json(&app.app, Method::GET, "/v1/agents", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "missing token should 401");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_missing_token", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": payload,
        }));
    });

    let request = Request::builder()
        .method(Method::GET)
        .uri("/v1/agents")
        .header(header::AUTHORIZATION, "Bearer wrong-token")
        .body(Body::empty())
        .expect("auth invalid request");
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "invalid token should 401");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_invalid_token", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": payload,
        }));
    });

    let request = Request::builder()
        .method(Method::GET)
        .uri("/v1/agents")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("auth valid request");
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "valid token should succeed");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_valid_token", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": normalize_agent_list(&payload),
        }));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cors_snapshots() {
    let cors = CorsLayer::new()
        .allow_origin("http://example.com".parse::<HeaderValue>().unwrap())
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);
    let app = TestApp::new_with_auth_and_cors(AuthConfig::disabled(), Some(cors));

    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/v1/agents")
        .header(header::ORIGIN, "http://example.com")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type",
        )
        .body(Body::empty())
        .expect("cors preflight request");
    let (status, headers, _payload) = send_request(&app.app, preflight).await;
    insta::with_settings!({
        snapshot_suffix => snapshot_name("cors_preflight", None),
    }, {
        insta::assert_yaml_snapshot!(snapshot_cors(status, &headers));
    });

    let actual = Request::builder()
        .method(Method::GET)
        .uri("/v1/health")
        .header(header::ORIGIN, "http://example.com")
        .body(Body::empty())
        .expect("cors actual request");
    let (status, headers, payload) = send_json_request(&app.app, actual).await;
    assert_eq!(status, StatusCode::OK, "cors actual request should succeed");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("cors_actual", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "cors": snapshot_cors(status, &headers),
            "payload": normalize_health(&payload),
        }));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_endpoints_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();

    let (status, health) = send_json(&app.app, Method::GET, "/v1/health", None).await;
    assert_eq!(status, StatusCode::OK, "health status");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("health", None),
    }, {
        insta::assert_yaml_snapshot!(normalize_health(&health));
    });

    // List agents (verify IDs only; install state is environment-dependent).
    let (status, agents) = send_json(&app.app, Method::GET, "/v1/agents", None).await;
    assert_eq!(status, StatusCode::OK, "agents list");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("agents_list", None),
    }, {
        insta::assert_yaml_snapshot!(normalize_agent_list(&agents));
    });

    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/agents/{}/install", config.agent.as_str()),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "install agent");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("agent_install", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(snapshot_status(status));
        });
    }

    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        let (status, modes) = send_json(
            &app.app,
            Method::GET,
            &format!("/v1/agents/{}/modes", config.agent.as_str()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "agent modes");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("agent_modes", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_agent_modes(&modes));
        });
    }

    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        let (status, models) = send_json(
            &app.app,
            Method::GET,
            &format!("/v1/agents/{}/models", config.agent.as_str()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "agent models");
        let model_count = models
            .get("models")
            .and_then(|value| value.as_array())
            .map(|models| models.len())
            .unwrap_or_default();
        assert!(model_count > 0, "agent models should not be empty");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("agent_models", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_agent_models(&models, config.agent));
        });
    }
}

fn pi_test_config() -> Option<TestAgentConfig> {
    let configs = match test_agents_from_env() {
        Ok(configs) => configs,
        Err(err) => {
            eprintln!("Skipping PI endpoint variant test: {err}");
            return None;
        }
    };
    configs
        .into_iter()
        .find(|config| config.agent == AgentId::Pi)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_capabilities_and_models_expose_variants() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, AgentId::Pi).await;

    let capabilities = fetch_capabilities(&app.app).await;
    let pi_caps = capabilities.get("pi").expect("pi capabilities");
    assert!(pi_caps.variants, "pi capabilities should enable variants");

    let (status, payload) = send_json(&app.app, Method::GET, "/v1/agents/pi/models", None).await;
    assert_eq!(status, StatusCode::OK, "pi models endpoint");
    let models = payload
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(!models.is_empty(), "pi models should not be empty");

    let full_levels = vec!["off", "minimal", "low", "medium", "high", "xhigh"];
    for model in models {
        let model_id = model
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>");
        let variants = model
            .get("variants")
            .and_then(Value::as_array)
            .expect("pi model variants");
        let default_variant = model
            .get("defaultVariant")
            .and_then(Value::as_str)
            .expect("pi model defaultVariant");
        let variant_ids = variants
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(
            !variant_ids.is_empty(),
            "pi model {model_id} has no variants"
        );
        if variant_ids == vec!["off"] {
            assert_eq!(
                default_variant, "off",
                "pi model {model_id} expected default off for non-thinking model"
            );
        } else {
            assert_eq!(
                variant_ids, full_levels,
                "pi model {model_id} expected full thinking levels"
            );
            assert_eq!(
                default_variant, "medium",
                "pi model {model_id} expected medium default for thinking model"
            );
        }
    }
}
