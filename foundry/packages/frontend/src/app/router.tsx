import { useEffect, useSyncExternalStore } from "react";
import { setFrontendErrorContext } from "@sandbox-agent/foundry-frontend-errors/client";
import { type MockBillingPlanId } from "@sandbox-agent/foundry-client";
import { Navigate, Outlet, createRootRoute, createRoute, createRouter, useNavigate, useRouterState } from "@tanstack/react-router";
import { MockLayout } from "../components/mock-layout";
import {
  MockHostedCheckoutPage,
  MockOrganizationBillingPage,
  MockOrganizationSelectorPage,
  MockOrganizationSettingsPage,
  MockSignInPage,
} from "../components/mock-onboarding";
import { defaultWorkspaceId } from "../lib/env";
import {
  activeMockOrganization,
  activeMockUser,
  getMockOrganizationById,
  isAppSnapshotBootstrapping,
  eligibleOrganizations,
  useMockAppClient,
  useMockAppSnapshot,
} from "../lib/mock-app";
import { getTaskWorkbenchClient, resolveRepoRouteTaskId } from "../lib/workbench";

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

const taskRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "tasks/$taskId",
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: typeof search.sessionId === "string" && search.sessionId.trim().length > 0 ? search.sessionId : undefined,
  }),
  component: TaskRoute,
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
  workspaceRoute.addChildren([workspaceIndexRoute, taskRoute, repoRoute]),
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
  const snapshot = useMockAppSnapshot();
  return <NavigateToMockHome snapshot={snapshot} replace />;
}

function SignInRoute() {
  const snapshot = useMockAppSnapshot();
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  if (snapshot.auth.status === "signed_in") {
    return <NavigateToMockHome snapshot={snapshot} replace />;
  }

  return <MockSignInPage />;
}

function OrganizationsRoute() {
  const snapshot = useMockAppSnapshot();
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  return <MockOrganizationSelectorPage />;
}

function OrganizationSettingsRoute() {
  const snapshot = useMockAppSnapshot();
  const organization = useGuardedMockOrganization(organizationSettingsRoute.useParams().organizationId);
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockOrganizationSettingsPage organization={organization} />;
}

function OrganizationBillingRoute() {
  const snapshot = useMockAppSnapshot();
  const organization = useGuardedMockOrganization(organizationBillingRoute.useParams().organizationId);
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  return <MockOrganizationBillingPage organization={organization} />;
}

function OrganizationCheckoutRoute() {
  const { organizationId, planId } = organizationCheckoutRoute.useParams();
  const snapshot = useMockAppSnapshot();
  const organization = useGuardedMockOrganization(organizationId);
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  if (!organization) {
    return <Navigate to="/organizations" replace />;
  }

  if (!isMockBillingPlanId(planId)) {
    return <Navigate to="/organizations/$organizationId/billing" params={{ organizationId }} replace />;
  }

  return <MockHostedCheckoutPage organization={organization} planId={planId} />;
}

function WorkspaceRoute() {
  const { workspaceId } = workspaceRoute.useParams();

  return (
    <MockWorkspaceGate workspaceId={workspaceId}>
      <WorkspaceView workspaceId={workspaceId} selectedTaskId={null} selectedSessionId={null} />
    </MockWorkspaceGate>
  );
}

function TaskRoute() {
  const { workspaceId, taskId } = taskRoute.useParams();
  const { sessionId } = taskRoute.useSearch();

  return (
    <MockWorkspaceGate workspaceId={workspaceId}>
      <WorkspaceView workspaceId={workspaceId} selectedTaskId={taskId} selectedSessionId={sessionId ?? null} />
    </MockWorkspaceGate>
  );
}

function RepoRoute() {
  const { workspaceId, repoId } = repoRoute.useParams();

  return (
    <MockWorkspaceGate workspaceId={workspaceId}>
      <RepoRouteInner workspaceId={workspaceId} repoId={repoId} />
    </MockWorkspaceGate>
  );
}

function RepoRouteInner({ workspaceId, repoId }: { workspaceId: string; repoId: string }) {
  const client = getTaskWorkbenchClient(workspaceId);
  const snapshot = useSyncExternalStore(client.subscribe.bind(client), client.getSnapshot.bind(client), client.getSnapshot.bind(client));

  useEffect(() => {
    setFrontendErrorContext({
      workspaceId,
      taskId: undefined,
      repoId,
    });
  }, [repoId, workspaceId]);

  const activeTaskId = resolveRepoRouteTaskId(snapshot, repoId);
  if (!activeTaskId) {
    return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId }} replace />;
  }
  return (
    <Navigate
      to="/workspaces/$workspaceId/tasks/$taskId"
      params={{
        workspaceId,
        taskId: activeTaskId,
      }}
      search={{ sessionId: undefined }}
      replace
    />
  );
}

function WorkspaceView({
  workspaceId,
  selectedTaskId,
  selectedSessionId,
}: {
  workspaceId: string;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
}) {
  const appClient = useMockAppClient();
  const client = getTaskWorkbenchClient(workspaceId);
  const navigate = useNavigate();
  const snapshot = useMockAppSnapshot();
  const organization = eligibleOrganizations(snapshot).find((candidate) => candidate.workspaceId === workspaceId) ?? null;

  useEffect(() => {
    setFrontendErrorContext({
      workspaceId,
      taskId: selectedTaskId ?? undefined,
      repoId: undefined,
    });
  }, [selectedTaskId, workspaceId]);

  return (
    <MockLayout
      client={client}
      workspaceId={workspaceId}
      selectedTaskId={selectedTaskId}
      selectedSessionId={selectedSessionId}
      sidebarTitle={organization?.settings.displayName}
      sidebarSubtitle={
        organization ? `${organization.billing.planId} plan · ${organization.seatAssignments.length}/${organization.billing.seatsIncluded} seats` : undefined
      }
      organizationGithub={organization?.github}
      onRetryGithubSync={organization ? () => void appClient.triggerGithubSync(organization.id) : undefined}
      onReconnectGithub={organization ? () => void appClient.reconnectGithub(organization.id) : undefined}
      sidebarActions={
        organization
          ? [
              {
                label: "Switch org",
                onClick: () => void navigate({ to: "/organizations" }),
              },
              {
                label: "Settings",
                onClick: () =>
                  void navigate({
                    to: "/organizations/$organizationId/settings",
                    params: { organizationId: organization.id },
                  }),
              },
              {
                label: "Billing",
                onClick: () =>
                  void navigate({
                    to: "/organizations/$organizationId/billing",
                    params: { organizationId: organization.id },
                  }),
              },
            ]
          : undefined
      }
    />
  );
}

function MockWorkspaceGate({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  const snapshot = useMockAppSnapshot();
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  if (snapshot.auth.status === "signed_out") {
    return <Navigate to="/signin" replace />;
  }

  const activeOrganization = activeMockOrganization(snapshot);
  const workspaceOrganization = eligibleOrganizations(snapshot).find((candidate) => candidate.workspaceId === workspaceId) ?? null;

  if (!workspaceOrganization) {
    return <NavigateToMockHome snapshot={snapshot} replace />;
  }

  if (!activeOrganization || activeOrganization.id !== workspaceOrganization.id) {
    return <Navigate to="/organizations" replace />;
  }

  return <>{children}</>;
}

function NavigateToMockHome({ snapshot, replace = false }: { snapshot: ReturnType<typeof useMockAppSnapshot>; replace?: boolean }) {
  if (isAppSnapshotBootstrapping(snapshot)) {
    return <AppBootstrapPending />;
  }

  const activeOrganization = activeMockOrganization(snapshot);
  const organizations = eligibleOrganizations(snapshot);
  const targetOrganization = activeOrganization ?? (organizations.length === 1 ? (organizations[0] ?? null) : null);

  if (snapshot.auth.status === "signed_out" || !activeMockUser(snapshot)) {
    return <Navigate to="/signin" replace={replace} />;
  }

  if (!targetOrganization) {
    return snapshot.users.length === 0 ? (
      <Navigate to="/workspaces/$workspaceId" params={{ workspaceId: defaultWorkspaceId }} replace={replace} />
    ) : (
      <Navigate to="/organizations" replace={replace} />
    );
  }

  return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId: targetOrganization.workspaceId }} replace={replace} />;
}

function useGuardedMockOrganization(organizationId: string) {
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);

  if (!user) {
    return null;
  }

  const organization = getMockOrganizationById(snapshot, organizationId);
  if (!organization) {
    return null;
  }

  return user.eligibleOrganizationIds.includes(organization.id) ? organization : null;
}

function isMockBillingPlanId(planId: string): planId is MockBillingPlanId {
  return planId === "free" || planId === "team";
}

function RootLayout() {
  return (
    <>
      <RouteContextSync />
      <Outlet />
    </>
  );
}

function AppBootstrapPending() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at top left, rgba(255, 79, 0, 0.16), transparent 28%), radial-gradient(circle at top right, rgba(24, 140, 255, 0.18), transparent 32%), #050505",
        color: "#ffffff",
      }}
    >
      <div
        style={{
          width: "min(520px, calc(100vw - 40px))",
          padding: "32px",
          borderRadius: "28px",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          background: "linear-gradient(180deg, rgba(21, 21, 24, 0.96), rgba(10, 10, 11, 0.98))",
          boxShadow: "0 18px 40px rgba(0, 0, 0, 0.36)",
        }}
      >
        <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#a1a1aa" }}>Restoring session</div>
        <div style={{ marginTop: "8px", fontSize: "28px", fontWeight: 800 }}>Loading Foundry state</div>
        <div style={{ marginTop: "12px", color: "#d4d4d8", lineHeight: 1.6 }}>
          Applying the returned app session and loading your organizations before routing deeper into Foundry.
        </div>
      </div>
    </div>
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
