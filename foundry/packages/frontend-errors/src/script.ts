import type { FrontendErrorCollectorScriptOptions } from "./types.js";

const DEFAULT_REPORTER = "foundry-frontend";

export function createFrontendErrorCollectorScript(options: FrontendErrorCollectorScriptOptions): string {
  const config = {
    endpoint: options.endpoint,
    reporter: options.reporter ?? DEFAULT_REPORTER,
    includeConsoleErrors: options.includeConsoleErrors ?? true,
    includeFetchErrors: options.includeFetchErrors ?? true,
  };

  return `(function () {
  if (typeof window === "undefined") {
    return;
  }

  if (window.__FOUNDRY_FRONTEND_ERROR_COLLECTOR__) {
    return;
  }

  var config = ${JSON.stringify(config)};
  var sharedContext = window.__FOUNDRY_FRONTEND_ERROR_CONTEXT__ || {};
  window.__FOUNDRY_FRONTEND_ERROR_CONTEXT__ = sharedContext;

  function now() {
    return Date.now();
  }

  function clampText(input, maxLength) {
    if (typeof input !== "string") {
      return null;
    }
    var value = input.trim();
    if (!value) {
      return null;
    }
    if (value.length <= maxLength) {
      return value;
    }
    return value.slice(0, maxLength) + "...(truncated)";
  }

  function currentRoute() {
    return location.pathname + location.search + location.hash;
  }

  function safeContext() {
    var copy = {};
    for (var key in sharedContext) {
      if (!Object.prototype.hasOwnProperty.call(sharedContext, key)) {
        continue;
      }
      var candidate = sharedContext[key];
      if (
        candidate === null ||
        candidate === undefined ||
        typeof candidate === "string" ||
        typeof candidate === "number" ||
        typeof candidate === "boolean"
      ) {
        copy[key] = candidate;
      }
    }
    copy.route = currentRoute();
    return copy;
  }

  function stringifyUnknown(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof Error) {
      return input.stack || input.message || String(input);
    }
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }

  var internalSendInFlight = false;

  function send(eventPayload) {
    var payload = {
      kind: eventPayload.kind || "window-error",
      message: clampText(eventPayload.message || "(no message)", 12000),
      stack: clampText(eventPayload.stack, 12000),
      source: clampText(eventPayload.source, 1024),
      line: typeof eventPayload.line === "number" ? eventPayload.line : null,
      column: typeof eventPayload.column === "number" ? eventPayload.column : null,
      url: clampText(eventPayload.url || location.href, 2048),
      timestamp: typeof eventPayload.timestamp === "number" ? eventPayload.timestamp : now(),
      context: safeContext(),
      extra: eventPayload.extra || {},
    };

    var body = JSON.stringify(payload);

    if (navigator.sendBeacon && body.length < 60000) {
      var blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(config.endpoint, blob);
      return;
    }

    if (internalSendInFlight) {
      return;
    }

    internalSendInFlight = true;
    fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: body,
    }).catch(function () {
      return;
    }).finally(function () {
      internalSendInFlight = false;
    });
  }

  window.__FOUNDRY_FRONTEND_ERROR_COLLECTOR__ = {
    setContext: function (nextContext) {
      if (!nextContext || typeof nextContext !== "object") {
        return;
      }
      for (var key in nextContext) {
        if (!Object.prototype.hasOwnProperty.call(nextContext, key)) {
          continue;
        }
        sharedContext[key] = nextContext[key];
      }
    },
  };

  if (config.includeConsoleErrors) {
    var originalConsoleError = console.error.bind(console);
    console.error = function () {
      var message = "";
      var values = [];
      for (var index = 0; index < arguments.length; index += 1) {
        values.push(stringifyUnknown(arguments[index]));
      }
      message = values.join(" ");
      send({
        kind: "console-error",
        message: message || "console.error called",
        timestamp: now(),
        extra: { args: values.slice(0, 10) },
      });
      return originalConsoleError.apply(console, arguments);
    };
  }

  window.addEventListener("error", function (event) {
    var target = event.target;
    var hasResourceTarget = target && target !== window && typeof target === "object";
    if (hasResourceTarget) {
      var url = null;
      if ("src" in target && typeof target.src === "string") {
        url = target.src;
      } else if ("href" in target && typeof target.href === "string") {
        url = target.href;
      }
      send({
        kind: "resource-error",
        message: "Resource failed to load",
        source: event.filename || null,
        line: typeof event.lineno === "number" ? event.lineno : null,
        column: typeof event.colno === "number" ? event.colno : null,
        url: url || location.href,
        stack: null,
        timestamp: now(),
      });
      return;
    }

    var message = clampText(event.message, 12000) || "Unhandled window error";
    var stack = event.error && event.error.stack ? String(event.error.stack) : null;
    send({
      kind: "window-error",
      message: message,
      stack: stack,
      source: event.filename || null,
      line: typeof event.lineno === "number" ? event.lineno : null,
      column: typeof event.colno === "number" ? event.colno : null,
      url: location.href,
      timestamp: now(),
    });
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var stack = reason && reason.stack ? String(reason.stack) : null;
    send({
      kind: "unhandled-rejection",
      message: stringifyUnknown(reason),
      stack: stack,
      url: location.href,
      timestamp: now(),
    });
  });

  if (config.includeFetchErrors && typeof window.fetch === "function") {
    var originalFetch = window.fetch.bind(window);
    window.fetch = function () {
      var args = arguments;
      var requestUrl = null;
      if (typeof args[0] === "string") {
        requestUrl = args[0];
      } else if (args[0] && typeof args[0].url === "string") {
        requestUrl = args[0].url;
      }

      return originalFetch.apply(window, args).then(function (response) {
        if (!response.ok && response.status >= 500) {
          send({
            kind: "fetch-response-error",
            message: "Fetch returned HTTP " + response.status,
            url: requestUrl || location.href,
            timestamp: now(),
            extra: {
              status: response.status,
              statusText: response.statusText,
            },
          });
        }
        return response;
      }).catch(function (error) {
        send({
          kind: "fetch-error",
          message: stringifyUnknown(error),
          stack: error && error.stack ? String(error.stack) : null,
          url: requestUrl || location.href,
          timestamp: now(),
        });
        throw error;
      });
    };
  }

})();`;
}
