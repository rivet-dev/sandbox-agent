import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BaseProvider } from "baseui";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Client as Styletron } from "styletron-engine-atomic";
import { Provider as StyletronProvider } from "styletron-react";
import { router } from "./app/router";
import { appTheme } from "./app/theme";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const styletronEngine = new Styletron();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StyletronProvider value={styletronEngine}>
      <BaseProvider theme={appTheme}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </BaseProvider>
    </StyletronProvider>
  </StrictMode>,
);
