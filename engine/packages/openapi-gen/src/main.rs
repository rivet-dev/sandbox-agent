use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let mut out: Option<PathBuf> = None;
    let mut stdout = false;
    let mut args = env::args().skip(1).peekable();
    while let Some(arg) = args.next() {
        if arg == "--stdout" {
            stdout = true;
            continue;
        }
        if arg == "--out" {
            if let Some(value) = args.next() {
                out = Some(PathBuf::from(value));
            }
            continue;
        }
        if let Some(value) = arg.strip_prefix("--out=") {
            out = Some(PathBuf::from(value));
            continue;
        }
        if out.is_none() {
            out = Some(PathBuf::from(arg));
        }
    }

    let schema = sandbox_daemon_openapi_gen::OPENAPI_JSON;
    if stdout {
        println!("{schema}");
        return;
    }

    let out = out.unwrap_or_else(|| PathBuf::from("openapi.json"));
    if let Err(err) = fs::write(&out, schema) {
        eprintln!("failed to write {}: {err}", out.display());
        std::process::exit(1);
    }
}
