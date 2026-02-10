use super::*;

// Canonical extension namespace used for ACP _meta values.
pub(super) const SANDBOX_META_KEY: &str = "sandboxagent.dev";

// _meta[sandboxagent.dev].extensions key in initialize response.
pub(super) const EXTENSIONS_META_KEY: &str = "extensions";
// _meta[sandboxagent.dev].extensions.sessionDetach => method _sandboxagent/session/detach
pub(super) const EXTENSION_KEY_SESSION_DETACH: &str = "sessionDetach";
// _meta[sandboxagent.dev].extensions.sessionTerminate => method _sandboxagent/session/terminate
pub(super) const EXTENSION_KEY_SESSION_TERMINATE: &str = "sessionTerminate";
// _meta[sandboxagent.dev].extensions.sessionEndedNotification => method _sandboxagent/session/ended
pub(super) const EXTENSION_KEY_SESSION_ENDED_NOTIFICATION: &str = "sessionEndedNotification";
// _meta[sandboxagent.dev].extensions.sessionListModels => method _sandboxagent/session/list_models
pub(super) const EXTENSION_KEY_SESSION_LIST_MODELS: &str = "sessionListModels";
// _meta[sandboxagent.dev].extensions.sessionSetMetadata => method _sandboxagent/session/set_metadata
pub(super) const EXTENSION_KEY_SESSION_SET_METADATA: &str = "sessionSetMetadata";
// _meta[sandboxagent.dev].extensions.sessionAgentMeta => session/new + initialize require _meta[sandboxagent.dev].agent
pub(super) const EXTENSION_KEY_SESSION_AGENT_META: &str = "sessionAgentMeta";
// _meta[sandboxagent.dev].extensions.agentList => method _sandboxagent/agent/list
pub(super) const EXTENSION_KEY_AGENT_LIST: &str = "agentList";
// _meta[sandboxagent.dev].extensions.agentInstall => method _sandboxagent/agent/install
pub(super) const EXTENSION_KEY_AGENT_INSTALL: &str = "agentInstall";
// _meta[sandboxagent.dev].extensions.sessionList => method _sandboxagent/session/list
pub(super) const EXTENSION_KEY_SESSION_LIST: &str = "sessionList";
// _meta[sandboxagent.dev].extensions.sessionGet => method _sandboxagent/session/get
pub(super) const EXTENSION_KEY_SESSION_GET: &str = "sessionGet";
// _meta[sandboxagent.dev].extensions.fsListEntries => method _sandboxagent/fs/list_entries
pub(super) const EXTENSION_KEY_FS_LIST_ENTRIES: &str = "fsListEntries";
// _meta[sandboxagent.dev].extensions.fsReadFile => method _sandboxagent/fs/read_file
pub(super) const EXTENSION_KEY_FS_READ_FILE: &str = "fsReadFile";
// _meta[sandboxagent.dev].extensions.fsWriteFile => method _sandboxagent/fs/write_file
pub(super) const EXTENSION_KEY_FS_WRITE_FILE: &str = "fsWriteFile";
// _meta[sandboxagent.dev].extensions.fsDeleteEntry => method _sandboxagent/fs/delete_entry
pub(super) const EXTENSION_KEY_FS_DELETE_ENTRY: &str = "fsDeleteEntry";
// _meta[sandboxagent.dev].extensions.fsMkdir => method _sandboxagent/fs/mkdir
pub(super) const EXTENSION_KEY_FS_MKDIR: &str = "fsMkdir";
// _meta[sandboxagent.dev].extensions.fsMove => method _sandboxagent/fs/move
pub(super) const EXTENSION_KEY_FS_MOVE: &str = "fsMove";
// _meta[sandboxagent.dev].extensions.fsStat => method _sandboxagent/fs/stat
pub(super) const EXTENSION_KEY_FS_STAT: &str = "fsStat";
// _meta[sandboxagent.dev].extensions.fsUploadBatch => method _sandboxagent/fs/upload_batch
pub(super) const EXTENSION_KEY_FS_UPLOAD_BATCH: &str = "fsUploadBatch";
// _meta[sandboxagent.dev].extensions.methods => list of supported extension methods
pub(super) const EXTENSION_KEY_METHODS: &str = "methods";

pub(super) fn extract_sandbox_session_meta(payload: &Value) -> Option<Map<String, Value>> {
    payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object)
        .and_then(|meta| meta.get(SANDBOX_META_KEY))
        .and_then(Value::as_object)
        .cloned()
}

pub(super) fn inject_extension_capabilities(payload: &mut Value) {
    let Some(result) = payload.get_mut("result").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(agent_capabilities) = result
        .get_mut("agentCapabilities")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let meta = agent_capabilities
        .entry("_meta".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(meta_object) = meta.as_object_mut() else {
        return;
    };
    let sandbox = meta_object
        .entry(SANDBOX_META_KEY.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(sandbox_object) = sandbox.as_object_mut() else {
        return;
    };

    sandbox_object.insert(
        EXTENSIONS_META_KEY.to_string(),
        json!({
            EXTENSION_KEY_SESSION_DETACH: true,
            EXTENSION_KEY_SESSION_TERMINATE: true,
            EXTENSION_KEY_SESSION_ENDED_NOTIFICATION: true,
            EXTENSION_KEY_SESSION_LIST_MODELS: true,
            EXTENSION_KEY_SESSION_SET_METADATA: true,
            EXTENSION_KEY_SESSION_AGENT_META: true,
            EXTENSION_KEY_AGENT_LIST: true,
            EXTENSION_KEY_AGENT_INSTALL: true,
            EXTENSION_KEY_SESSION_LIST: true,
            EXTENSION_KEY_SESSION_GET: true,
            EXTENSION_KEY_FS_LIST_ENTRIES: true,
            EXTENSION_KEY_FS_READ_FILE: true,
            EXTENSION_KEY_FS_WRITE_FILE: true,
            EXTENSION_KEY_FS_DELETE_ENTRY: true,
            EXTENSION_KEY_FS_MKDIR: true,
            EXTENSION_KEY_FS_MOVE: true,
            EXTENSION_KEY_FS_STAT: true,
            EXTENSION_KEY_FS_UPLOAD_BATCH: true,
            EXTENSION_KEY_METHODS: [
                SESSION_DETACH_METHOD,
                SESSION_TERMINATE_METHOD,
                SESSION_ENDED_METHOD,
                SESSION_LIST_MODELS_METHOD,
                SESSION_SET_METADATA_METHOD,
                AGENT_LIST_METHOD,
                AGENT_INSTALL_METHOD,
                SESSION_LIST_METHOD,
                SESSION_GET_METHOD,
                FS_LIST_ENTRIES_METHOD,
                FS_READ_FILE_METHOD,
                FS_WRITE_FILE_METHOD,
                FS_DELETE_ENTRY_METHOD,
                FS_MKDIR_METHOD,
                FS_MOVE_METHOD,
                FS_STAT_METHOD,
                FS_UPLOAD_BATCH_METHOD,
            ]
        }),
    );
}
