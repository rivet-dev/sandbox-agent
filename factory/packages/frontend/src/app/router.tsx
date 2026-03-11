import { type ReactNode, useEffect } from "react";
import { setFrontendErrorContext } from "@openhandoff/frontend-errors/client";
import { Navigate, Outlet, createRootRoute, createRoute, createRouter, useRouterState } from "@tanstack/react-router";
import { MockLayout } from "../components/mock-layout";
import {
  MockHostedCheckoutPage,
  MockOrganizationBillingPage,
  MockOrganizationSelectorPage,
  MockOrganizationSettingsPage,
  MockSignInPage,
} from "../components/mock-onboarding";
import { defaultWorkspaceId, isMockFrontendClient } from "../lib/env";
import { activeMockOrganization, getMockOrganizationById, useMockAppClient, useMockAppSnapshot } from "../lib/mock-app";
import { handoffWorkbenchClient } from "../lib/workbench";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRoute,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin",
  component: SignInRoute,
});

const organizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations",
  component: OrganizationsRoute,
});

const organizationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/settings",
  component: OrganizationSettingsRoute,
});

const organizationBillingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/billing",
  component: OrganizationBillingRoute,
});

const organizationCheckoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations/$organizationId/checkout/$planId",
  component: OrganizationCheckoutRoute,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId",
  component: WorkspaceLayoutRoute,
});

const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  component: WorkspaceRoute,
});

const handoffRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "handoffs/$handoffId",
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: typeof search.sessionId === "string" && search.sessionId.trim().length > 0 ? search.sessionId : undefined,
  }),
  component: HandoffRoute,
});

const repoRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "repos/$repoId",
  component: RepoRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signInRoute,
  organizationsRoute,
  organizationSettingsRoute,
  organizationBillingRoute,
  organizationCheckoutRoute,
  workspaceRoute.addChildren([workspaceIndexRoute, handoffRoute, repoRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function WorkspaceLayoutRoute() {
  return <Outlet />;
}

function IndexRoute() {
  if (!isMockFrontendClient) {
    return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId: defaultWorkspaceId }} replace />;
  }

  const snapshot = useMockAppSnapshot();
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const activeOrganization = activeMockOrganization(snapshot);
  if (activeOrganization) {
    return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId: activeOrganization.workspaceId }} replace />;
  }

  return <Navigate to="/organizations" replace />;
}

function SignInRoute() {
  if (!isMockFrontendClient) {
    return <Navigate to="/" replace />;
  }

  const snapshot = useMockAppSnapshot();
  if (snapshot.auth.status === "signed_in") {
    return <IndexRoute />;
  }

  return <MockSignInPage />;
}

function OrganizationsRoute() {
  if (!isMockFrontendClient) {
    return <Navigate to="/" replace />;
  }

  const snapshot = useMockAppSnapshot();
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  return <MockOrganizationSelectorPage />;
}

function OrganizationSettingsRoute() {
  if (!isMockFrontendClient) {
    return <Navigate to="/" replace />;
  }

  const snapshot = useMockAppSnapshot();
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const { organizationId } = organizationSettingsRoute.useParams();
  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockOrganizationSettingsPage organization={organization} />;
}

function OrganizationBillingRoute() {
  if (!isMockFrontendClient) {
    return <Navigate to="/" replace />;
  }

  const snapshot = useMockAppSnapshot();
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const { organizationId } = organizationBillingRoute.useParams();
  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockOrganizationBillingPage organization={organization} />;
}

function OrganizationCheckoutRoute() {
  if (!isMockFrontendClient) {
    return <Navigate to="/" replace />;
  }

  const snapshot = useMockAppSnapshot();
  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const { organizationId, planId } = organizationCheckoutRoute.useParams();
  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockHostedCheckoutPage organization={organization} planId={planId} />;
}

function WorkspaceRoute() {
  const { workspaceId } = workspaceRoute.useParams();
  if (isMockFrontendClient) {
    return (
      <MockWorkspaceGate workspaceId={workspaceId}>
        <WorkspaceView workspaceId={workspaceId} selectedHandoffId={null} selectedSessionId={null} />
      </MockWorkspaceGate>
    );
  }

  return <WorkspaceView workspaceId={workspaceId} selectedHandoffId={null} selectedSessionId={null} />;
}

function WorkspaceView({
  workspaceId,
  selectedHandoffId,
  selectedSessionId,
}: {
  workspaceId: string;
  selectedHandoffId: string | null;
  selectedSessionId: string | null;
}) {
  useEffect(() => {
    setFrontendErrorContext({
      workspaceId,
      handoffId: undefined,
    });
  }, [workspaceId]);

  return <MockLayout workspaceId={workspaceId} selectedHandoffId={selectedHandoffId} selectedSessionId={selectedSessionId} />;
}

function HandoffRoute() {
  const { workspaceId, handoffId } = handoffRoute.useParams();
  const { sessionId } = handoffRoute.useSearch();
  if (isMockFrontendClient) {
    return (
      <MockWorkspaceGate workspaceId={workspaceId}>
        <HandoffView workspaceId={workspaceId} handoffId={handoffId} sessionId={sessionId ?? null} />
      </MockWorkspaceGate>
    );
  }

  return <HandoffView workspaceId={workspaceId} handoffId={handoffId} sessionId={sessionId ?? null} />;
}

function HandoffView({ workspaceId, handoffId, sessionId }: { workspaceId: string; handoffId: string; sessionId: string | null }) {
  useEffect(() => {
    setFrontendErrorContext({
      workspaceId,
      handoffId,
      repoId: undefined,
    });
  }, [handoffId, workspaceId]);

  return <MockLayout workspaceId={workspaceId} selectedHandoffId={handoffId} selectedSessionId={sessionId} />;
}

function RepoRoute() {
  const { workspaceId, repoId } = repoRoute.useParams();
  if (isMockFrontendClient) {
    return (
      <MockWorkspaceGate workspaceId={workspaceId}>
        <RepoRouteInner workspaceId={workspaceId} repoId={repoId} />
      </MockWorkspaceGate>
    );
  }

  return <RepoRouteInner workspaceId={workspaceId} repoId={repoId} />;
}

function MockWorkspaceGate({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const organization = snapshot.organizations.find((candidate) => candidate.workspaceId === workspaceId) ?? null;

  useEffect(() => {
    if (organization && snapshot.activeOrganizationId !== organization.id) {
      void client.selectOrganization(organization.id);
    }
  }, [client, organization, snapshot.activeOrganizationId]);

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <>{children}</>;
}

function RepoRouteInner({ workspaceId, repoId }: { workspaceId: string; repoId: string }) {
  useEffect(() => {
    setFrontendErrorContext({
      workspaceId,
      handoffId: undefined,
      repoId,
    });
  }, [repoId, workspaceId]);
  const activeHandoffId = handoffWorkbenchClient.getSnapshot().handoffs.find((handoff) => handoff.repoId === repoId)?.id;
  if (!activeHandoffId) {
    return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId }} replace />;
  }
  return (
    <Navigate
      to="/workspaces/$workspaceId/handoffs/$handoffId"
      params={{ workspaceId, handoffId: activeHandoffId }}
      search={{ sessionId: undefined }}
      replace
    />
  );
}

function RootLayout() {
  return (
    <>
      <RouteContextSync />
      <Outlet />
    </>
  );
}

function RouteContextSync() {
  const location = useRouterState({
    select: (state) => state.location,
  });

  useEffect(() => {
    setFrontendErrorContext({
      route: `${location.pathname}${location.search}${location.hash}`,
    });
  }, [location.hash, location.pathname, location.search]);

  return null;
}
