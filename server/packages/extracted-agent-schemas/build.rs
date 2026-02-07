use std::fs;
use std::io::{self, Write};
use std::path::Path;

fn main() {
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let schema_dir = Path::new("../../../resources/agent-schemas/artifacts/json-schema");

    let schemas = [
        ("opencode", "opencode.json"),
        ("claude", "claude.json"),
        ("codex", "codex.json"),
        ("amp", "amp.json"),
        ("pi", "pi.json"),
    ];

    for (name, file) in schemas {
        let schema_path = schema_dir.join(file);

        // Tell cargo to rerun if schema changes
        emit_stdout(&format!("cargo:rerun-if-changed={}", schema_path.display()));

        if !schema_path.exists() {
            emit_stdout(&format!(
                "cargo:warning=Schema file not found: {}",
                schema_path.display()
            ));
            // Write empty module
            let out_path = Path::new(&out_dir).join(format!("{}.rs", name));
            fs::write(&out_path, "// Schema not found\n").unwrap();
            continue;
        }

        let schema_content = fs::read_to_string(&schema_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {}", schema_path.display(), e));

        let schema: schemars::schema::RootSchema = serde_json::from_str(&schema_content)
            .unwrap_or_else(|e| panic!("Failed to parse {}: {}", schema_path.display(), e));

        let mut type_space = typify::TypeSpace::default();

        type_space
            .add_root_schema(schema)
            .unwrap_or_else(|e| panic!("Failed to process {}: {}", schema_path.display(), e));

        let contents = type_space.to_stream();

        // Format the generated code
        let formatted = prettyplease::unparse(
            &syn::parse2(contents.clone())
                .unwrap_or_else(|e| panic!("Failed to parse generated code for {}: {}", name, e)),
        );

        let out_path = Path::new(&out_dir).join(format!("{}.rs", name));
        fs::write(&out_path, formatted)
            .unwrap_or_else(|e| panic!("Failed to write {}: {}", out_path.display(), e));

        // emit_stdout(&format!(
        //     "cargo:warning=Generated {} types from {}",
        //     name, file
        // ));
    }
}

fn emit_stdout(message: &str) {
    let mut out = io::stdout();
    let _ = out.write_all(message.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
