use crate::desktop_install::{
    detect_package_manager, find_binary, prompt_yes_no, render_install_command,
    run_install_commands, running_as_root, DesktopPackageManager,
};

const AUTOMATIC_INSTALL_SUPPORTED_DISTROS: &str =
    "Automatic browser dependency installation is supported on Debian/Ubuntu (apt), Fedora/RHEL (dnf), and Alpine (apk).";
const AUTOMATIC_INSTALL_UNSUPPORTED_ENVS: &str =
    "Automatic installation is not supported on macOS, Windows, or Linux distributions without apt, dnf, or apk.";

#[derive(Debug, Clone)]
pub struct BrowserInstallRequest {
    pub yes: bool,
    pub print_only: bool,
    pub package_manager: Option<DesktopPackageManager>,
}

pub(crate) fn browser_platform_support_message() -> String {
    format!("Browser APIs are only supported on Linux. {AUTOMATIC_INSTALL_SUPPORTED_DISTROS}")
}

fn linux_install_support_message() -> String {
    format!("{AUTOMATIC_INSTALL_SUPPORTED_DISTROS} {AUTOMATIC_INSTALL_UNSUPPORTED_ENVS}")
}

pub fn install_browser(request: BrowserInstallRequest) -> Result<(), String> {
    if std::env::consts::OS != "linux" {
        return Err(format!(
            "browser installation is only supported on Linux. {}",
            linux_install_support_message()
        ));
    }

    let package_manager = match request.package_manager {
        Some(value) => value,
        None => detect_package_manager().ok_or_else(|| {
            format!(
                "could not detect a supported package manager. {} Install the browser dependencies manually on this distribution.",
                linux_install_support_message()
            )
        })?,
    };

    let packages = browser_packages(package_manager);
    let used_sudo = !running_as_root() && find_binary("sudo").is_some();
    if !running_as_root() && !used_sudo {
        return Err(
            "browser installation requires root or sudo access; rerun as root or install dependencies manually"
                .to_string(),
        );
    }

    println!("Browser package manager: {}", package_manager);
    println!("Browser packages:");
    for package in &packages {
        println!("  - {package}");
    }
    println!("Install command:");
    println!(
        "  {}",
        render_install_command(package_manager, used_sudo, &packages)
    );

    if request.print_only {
        return Ok(());
    }

    if !request.yes && !prompt_yes_no("Proceed with browser dependency installation? [y/N] ")? {
        return Err("installation cancelled".to_string());
    }

    run_install_commands(package_manager, used_sudo, &packages)?;

    println!("Browser dependencies installed.");
    Ok(())
}

fn browser_packages(package_manager: DesktopPackageManager) -> Vec<String> {
    match package_manager {
        DesktopPackageManager::Apt => vec![
            "chromium",
            "chromium-sandbox",
            "libnss3",
            "libatk-bridge2.0-0",
            "libdrm2",
            "libxcomposite1",
            "libxdamage1",
            "libxrandr2",
            "libgbm1",
            "libasound2",
            "libpangocairo-1.0-0",
            "libgtk-3-0",
        ],
        DesktopPackageManager::Dnf => vec!["chromium"],
        DesktopPackageManager::Apk => vec!["chromium", "nss"],
    }
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Checks for missing browser dependencies (Chromium binary and desktop libs).
pub(crate) fn detect_missing_browser_dependencies() -> Vec<String> {
    let mut missing = Vec::new();

    // Check for chromium binary (may be named chromium or chromium-browser)
    if find_binary("chromium").is_none() && find_binary("chromium-browser").is_none() {
        missing.push("chromium".to_string());
    }

    // Check for key desktop dependency libraries
    for (name, binary) in [("Xvfb", "Xvfb"), ("xrandr", "xrandr")] {
        if find_binary(binary).is_none() {
            missing.push(name.to_string());
        }
    }

    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_platform_support_message_mentions_linux_and_supported_distros() {
        let message = browser_platform_support_message();
        assert!(message.contains("only supported on Linux"));
        assert!(message.contains("Debian/Ubuntu (apt)"));
        assert!(message.contains("Fedora/RHEL (dnf)"));
        assert!(message.contains("Alpine (apk)"));
    }

    #[test]
    fn browser_packages_apt_includes_chromium_and_libs() {
        let packages = browser_packages(DesktopPackageManager::Apt);
        assert!(packages.iter().any(|p| p == "chromium"));
        assert!(packages.iter().any(|p| p == "libnss3"));
        assert!(packages.iter().any(|p| p == "libgbm1"));
    }

    #[test]
    fn browser_packages_dnf_includes_chromium() {
        let packages = browser_packages(DesktopPackageManager::Dnf);
        assert_eq!(packages, vec!["chromium"]);
    }

    #[test]
    fn browser_packages_apk_includes_chromium_and_nss() {
        let packages = browser_packages(DesktopPackageManager::Apk);
        assert_eq!(packages, vec!["chromium", "nss"]);
    }
}
