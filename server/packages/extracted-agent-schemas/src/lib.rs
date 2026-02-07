//! Generated types from AI coding agent JSON schemas.
//!
//! This crate provides Rust types for:
//! - OpenCode SDK
//! - Claude Code SDK
//! - Codex SDK
//! - AMP Code SDK
//! - Pi RPC

pub mod opencode {
    //! OpenCode SDK types extracted from OpenAPI 3.1.1 spec.
    include!(concat!(env!("OUT_DIR"), "/opencode.rs"));
}

pub mod claude {
    //! Claude Code SDK types extracted from TypeScript definitions.
    include!(concat!(env!("OUT_DIR"), "/claude.rs"));
}

pub mod codex {
    //! Codex SDK types.
    include!(concat!(env!("OUT_DIR"), "/codex.rs"));
}

pub mod amp {
    //! AMP Code SDK types.
    include!(concat!(env!("OUT_DIR"), "/amp.rs"));
}

pub mod pi {
    //! Pi RPC types.
    include!(concat!(env!("OUT_DIR"), "/pi.rs"));
}
