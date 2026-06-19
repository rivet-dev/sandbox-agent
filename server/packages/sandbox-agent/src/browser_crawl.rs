use std::collections::{HashSet, VecDeque};

use serde_json::Value;
use tokio::sync::mpsc;
use url::Url;

use crate::browser_cdp::CdpClient;
use crate::browser_errors::BrowserProblem;
use crate::browser_types::{
    BrowserCrawlExtract, BrowserCrawlPage, BrowserCrawlRequest, BrowserCrawlResponse,
};

/// Perform a BFS crawl starting from the given URL.
///
/// Navigates to each page via CDP, extracts content according to the requested
/// format, collects links, and follows them breadth-first within the configured
/// domain and depth limits.
pub async fn crawl_pages(
    cdp: &CdpClient,
    request: &BrowserCrawlRequest,
) -> Result<BrowserCrawlResponse, BrowserProblem> {
    let max_pages = request.max_pages.unwrap_or(10).min(100) as usize;
    let max_depth = request.max_depth.unwrap_or(2);
    let extract = request.extract.unwrap_or(BrowserCrawlExtract::Markdown);

    // Parse the starting URL to determine the default allowed domain.
    let start_url = Url::parse(&request.url)
        .map_err(|e| BrowserProblem::cdp_error(format!("Invalid start URL: {e}")))?;

    // Only allow http and https schemes to prevent local filesystem reading.
    match start_url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(BrowserProblem::invalid_url(format!(
                "Unsupported URL scheme '{scheme}'. Only http and https are allowed."
            )));
        }
    }

    let allowed_domains: HashSet<String> = if let Some(ref domains) = request.allowed_domains {
        domains.iter().cloned().collect()
    } else {
        // Default: only crawl same domain as start URL.
        let mut set = HashSet::new();
        if let Some(host) = start_url.host_str() {
            set.insert(host.to_string());
        }
        set
    };

    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    let mut pages: Vec<BrowserCrawlPage> = Vec::new();

    queue.push_back((request.url.clone(), 0));
    visited.insert(normalize_url(&request.url));

    cdp.send("Page.enable", None).await?;
    cdp.send("Network.enable", None).await?;
    let mut network_rx = cdp.subscribe("Network.responseReceived").await;

    while let Some((url, depth)) = queue.pop_front() {
        if pages.len() >= max_pages {
            // Push back so truncated detection sees remaining work.
            queue.push_front((url, depth));
            break;
        }

        // Navigate to the page.
        let nav_result = cdp
            .send("Page.navigate", Some(serde_json::json!({ "url": url })))
            .await?;

        // If Page.navigate returns an errorText, the navigation failed (e.g. DNS
        // error, connection refused). Record the page with no status and skip
        // content/link extraction.
        let error_text = nav_result
            .get("errorText")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        if error_text.is_some() {
            pages.push(BrowserCrawlPage {
                url,
                title: String::new(),
                content: String::new(),
                links: vec![],
                status: None,
                depth,
            });
            continue;
        }

        let frame_id = nav_result
            .get("frameId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Wait for page load by polling document.readyState until "complete".
        // Polls every 100ms with a 10s timeout; proceeds with extraction if timeout reached.
        let poll_interval = std::time::Duration::from_millis(100);
        let load_timeout = std::time::Duration::from_secs(10);
        let start_time = std::time::Instant::now();
        loop {
            if start_time.elapsed() >= load_timeout {
                break;
            }
            let ready_result = cdp
                .send(
                    "Runtime.evaluate",
                    Some(serde_json::json!({
                        "expression": "document.readyState",
                        "returnByValue": true
                    })),
                )
                .await;
            if let Ok(val) = ready_result {
                let state = val
                    .get("result")
                    .and_then(|r| r.get("value"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if state == "complete" {
                    break;
                }
            }
            tokio::time::sleep(poll_interval).await;
        }

        // Capture the real HTTP status from Network.responseReceived events.
        // After readyState is "complete", all document-level network events should
        // have been buffered. We drain them looking for the last Document response
        // matching this frame (the last one handles redirects correctly).
        let status = drain_navigation_status(&mut network_rx, &frame_id);

        // Get page info.
        let (page_url, title) = get_page_info(cdp).await?;

        // Extract content based on requested mode.
        let content = extract_content(cdp, extract).await?;

        // Collect links for further crawling.
        let links = extract_links(cdp).await?;

        pages.push(BrowserCrawlPage {
            url: page_url,
            title,
            content,
            links: links.clone(),
            status,
            depth,
        });

        // Enqueue discovered links if we haven't reached max depth.
        if depth < max_depth {
            for link in &links {
                let normalized = normalize_url(link);
                if visited.contains(&normalized) {
                    continue;
                }
                if let Ok(parsed) = Url::parse(link) {
                    if parsed.scheme() != "http" && parsed.scheme() != "https" {
                        continue;
                    }
                    if let Some(host) = parsed.host_str() {
                        if !allowed_domains.is_empty() && !allowed_domains.contains(host) {
                            continue;
                        }
                    }
                    visited.insert(normalized);
                    queue.push_back((link.clone(), depth + 1));
                }
            }
        }
    }

    let total_pages = pages.len() as u32;
    let truncated = !queue.is_empty();

    Ok(BrowserCrawlResponse {
        pages,
        total_pages,
        truncated,
    })
}

/// Drain buffered `Network.responseReceived` events and return the HTTP status
/// of the last Document-type response matching the given frame ID.
///
/// Takes the *last* matching status to handle redirect chains correctly (the
/// final destination response comes last). Returns `None` for non-HTTP schemes
/// like `file://` where no network events are emitted.
fn drain_navigation_status(
    network_rx: &mut mpsc::UnboundedReceiver<Value>,
    frame_id: &str,
) -> Option<u16> {
    let mut status = None;
    while let Ok(event) = network_rx.try_recv() {
        let event_frame = event.get("frameId").and_then(|v| v.as_str()).unwrap_or("");
        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if event_frame == frame_id && event_type == "Document" {
            if let Some(s) = event
                .get("response")
                .and_then(|r| r.get("status"))
                .and_then(|s| s.as_u64())
            {
                status = Some(s as u16);
            }
        }
    }
    status
}

/// Normalize a URL by removing the fragment for deduplication.
fn normalize_url(url: &str) -> String {
    if let Ok(mut parsed) = Url::parse(url) {
        parsed.set_fragment(None);
        parsed.to_string()
    } else {
        url.to_string()
    }
}

/// Get the current page URL and title via CDP Runtime.evaluate.
async fn get_page_info(cdp: &CdpClient) -> Result<(String, String), BrowserProblem> {
    let url_result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": "document.location.href",
                "returnByValue": true
            })),
        )
        .await?;
    let url = url_result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let title_result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": "document.title",
                "returnByValue": true
            })),
        )
        .await?;
    let title = title_result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok((url, title))
}

/// Extract page content according to the requested format.
async fn extract_content(
    cdp: &CdpClient,
    extract: BrowserCrawlExtract,
) -> Result<String, BrowserProblem> {
    match extract {
        BrowserCrawlExtract::Html => {
            let result = cdp
                .send(
                    "Runtime.evaluate",
                    Some(serde_json::json!({
                        "expression": "document.documentElement.outerHTML",
                        "returnByValue": true
                    })),
                )
                .await?;
            Ok(result
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string())
        }
        BrowserCrawlExtract::Text => {
            let result = cdp
                .send(
                    "Runtime.evaluate",
                    Some(serde_json::json!({
                        "expression": "document.body.innerText",
                        "returnByValue": true
                    })),
                )
                .await?;
            Ok(result
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string())
        }
        BrowserCrawlExtract::Markdown => {
            let expression = r#"
                (function() {
                    var clone = document.body.cloneNode(true);
                    var selectors = ['nav', 'footer', 'aside', 'header', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'];
                    selectors.forEach(function(sel) {
                        clone.querySelectorAll(sel).forEach(function(el) { el.remove(); });
                    });
                    return clone.innerHTML;
                })()
            "#;
            let result = cdp
                .send(
                    "Runtime.evaluate",
                    Some(serde_json::json!({
                        "expression": expression,
                        "returnByValue": true
                    })),
                )
                .await?;
            let html = result
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(html2md::parse_html(html))
        }
        BrowserCrawlExtract::Links => {
            // For "links" extraction, content is empty; links are in the links field.
            Ok(String::new())
        }
    }
}

/// Extract all http/https links from the current page.
async fn extract_links(cdp: &CdpClient) -> Result<Vec<String>, BrowserProblem> {
    let expression = r#"
        (function() {
            var links = [];
            document.querySelectorAll('a[href]').forEach(function(a) {
                if (a.href && a.href.startsWith('http')) {
                    links.push(a.href);
                }
            });
            return JSON.stringify(links);
        })()
    "#;
    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;
    let json_str = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("[]");
    let links: Vec<String> = serde_json::from_str(json_str).unwrap_or_default();
    Ok(links)
}
