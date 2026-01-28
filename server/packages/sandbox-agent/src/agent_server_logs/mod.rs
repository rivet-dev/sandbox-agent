#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::AgentServerLogs;
#[cfg(windows)]
pub use windows::AgentServerLogs;
