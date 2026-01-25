#!/bin/sh
# shellcheck enable=add-default-case
# shellcheck enable=avoid-nullary-conditions
# shellcheck enable=check-unassigned-uppercase
# shellcheck enable=deprecate-which
# shellcheck enable=quote-safe-variables
# shellcheck enable=require-variable-braces
set -eu

WORK_DIR="/tmp/sandbox_daemon_install"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

SANDBOX_DAEMON_VERSION="${SANDBOX_DAEMON_VERSION:-__VERSION__}"
SANDBOX_DAEMON_BASE_URL="${SANDBOX_DAEMON_BASE_URL:-https://releases.rivet.dev}"
UNAME="$(uname -s)"
ARCH="$(uname -m)"

if [ "$(printf '%s' "$UNAME" | cut -c 1-6)" = "Darwin" ]; then
	if [ "$ARCH" = "x86_64" ]; then
		FILE_NAME="sandbox-daemon-x86_64-apple-darwin"
	elif [ "$ARCH" = "arm64" ]; then
		FILE_NAME="sandbox-daemon-aarch64-apple-darwin"
	else
		echo "Unknown arch $ARCH" 1>&2
		exit 1
	fi
elif [ "$(printf '%s' "$UNAME" | cut -c 1-5)" = "Linux" ]; then
	if [ "$ARCH" = "x86_64" ]; then
		FILE_NAME="sandbox-daemon-x86_64-unknown-linux-musl"
	else
		echo "Unsupported Linux arch $ARCH" 1>&2
		exit 1
	fi
else
	echo "Unable to determine platform" 1>&2
	exit 1
fi

set +u
if [ -z "$BIN_DIR" ]; then
	BIN_DIR="/usr/local/bin"
fi
set -u

INSTALL_PATH="$BIN_DIR/sandbox-daemon"

if [ ! -d "$BIN_DIR" ]; then
	CHECK_DIR="$BIN_DIR"
	while [ ! -d "$CHECK_DIR" ] && [ "$CHECK_DIR" != "/" ]; do
		CHECK_DIR=$(dirname "$CHECK_DIR")
	done

	if [ ! -w "$CHECK_DIR" ]; then
		echo "> Creating directory $BIN_DIR (requires sudo)"
		sudo mkdir -p "$BIN_DIR"
	else
		echo "> Creating directory $BIN_DIR"
		mkdir -p "$BIN_DIR"
	fi
fi

URL="$SANDBOX_DAEMON_BASE_URL/sandbox-daemon/${SANDBOX_DAEMON_VERSION}/${FILE_NAME}"
echo "> Downloading $URL"

curl -fsSL "$URL" -o sandbox-daemon
chmod +x sandbox-daemon

if [ ! -w "$BIN_DIR" ]; then
	echo "> Installing sandbox-daemon to $INSTALL_PATH (requires sudo)"
	sudo mv ./sandbox-daemon "$INSTALL_PATH"
else
	echo "> Installing sandbox-daemon to $INSTALL_PATH"
	mv ./sandbox-daemon "$INSTALL_PATH"
fi

case ":$PATH:" in
	*:$BIN_DIR:*) ;;
	*)
		echo "WARNING: $BIN_DIR is not in \$PATH"
		echo "For instructions on how to add it to your PATH, visit:"
		echo "https://opensource.com/article/17/6/set-path-linux"
		;;
esac

echo "sandbox-daemon installed successfully."
