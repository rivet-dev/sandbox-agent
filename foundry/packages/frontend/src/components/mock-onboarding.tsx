import { useEffect, useMemo, useState } from "react";
import { type FoundryBillingPlanId, type FoundryOrganization, type FoundryOrganizationMember, type FoundryUser } from "@sandbox-agent/foundry-shared";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, BadgeCheck, Building2, CreditCard, Github, ShieldCheck, Star, Users } from "lucide-react";
import { activeMockUser, eligibleOrganizations, useMockAppClient, useMockAppSnapshot } from "../lib/mock-app";
import { isMockFrontendClient } from "../lib/env";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const planCatalog: Record<
  FoundryBillingPlanId,
  {
    label: string;
    price: string;
    seats: string;
    summary: string;
  }
> = {
  free: {
    label: "Free",
    price: "$0",
    seats: "1 seat included",
    summary: "Best for a personal workspace and quick evaluations.",
  },
  team: {
    label: "Team",
    price: "$240/mo",
    seats: "5 seats included",
    summary: "GitHub org onboarding, shared billing, and seat accrual on first prompt.",
  },
};

function appSurfaceStyle(): React.CSSProperties {
  return {
    minHeight: "100dvh",
    display: "flex",
    flexDirection: "column",
    background:
      "radial-gradient(circle at top left, rgba(255, 79, 0, 0.16), transparent 28%), radial-gradient(circle at top right, rgba(24, 140, 255, 0.18), transparent 32%), #050505",
    color: "#ffffff",
  };
}

function topBarStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 28px",
    borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
    background: "rgba(0, 0, 0, 0.36)",
    backdropFilter: "blur(16px)",
  };
}

function contentWrapStyle(): React.CSSProperties {
  return {
    width: "min(1180px, calc(100vw - 40px))",
    margin: "0 auto",
    padding: "28px 0 40px",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  };
}

function primaryButtonStyle(): React.CSSProperties {
  return {
    border: 0,
    borderRadius: "999px",
    padding: "11px 16px",
    background: "#ff4f00",
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
  };
}

function secondaryButtonStyle(): React.CSSProperties {
  return {
    border: "1px solid rgba(255, 255, 255, 0.16)",
    borderRadius: "999px",
    padding: "10px 15px",
    background: "rgba(255, 255, 255, 0.03)",
    color: "#ffffff",
    fontWeight: 600,
    cursor: "pointer",
  };
}

function subtleButtonStyle(): React.CSSProperties {
  return {
    border: 0,
    borderRadius: "999px",
    padding: "10px 14px",
    background: "rgba(255, 255, 255, 0.05)",
    color: "#ffffff",
    fontWeight: 600,
    cursor: "pointer",
  };
}

function cardStyle(): React.CSSProperties {
  return {
    background: "linear-gradient(180deg, rgba(21, 21, 24, 0.96), rgba(10, 10, 11, 0.98))",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    borderRadius: "24px",
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.36)",
  };
}

function badgeStyle(background: string, color = "#f4f4f5"): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    borderRadius: "999px",
    background,
    color,
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.01em",
  };
}

function formatDate(value: string | null): string {
  if (!value) {
    return "N/A";
  }
  return dateFormatter.format(new Date(value));
}

function workspacePath(organization: FoundryOrganization): string {
  return `/workspaces/${organization.workspaceId}`;
}

function settingsPath(organization: FoundryOrganization): string {
  return `/organizations/${organization.id}/settings`;
}

function billingPath(organization: FoundryOrganization): string {
  return `/organizations/${organization.id}/billing`;
}

function checkoutPath(organization: FoundryOrganization, planId: FoundryBillingPlanId): string {
  return `/organizations/${organization.id}/checkout/${planId}`;
}

function statusBadge(organization: FoundryOrganization) {
  if (organization.kind === "personal") {
    return <span style={badgeStyle("rgba(24, 140, 255, 0.18)", "#b9d8ff")}>Personal workspace</span>;
  }
  return <span style={badgeStyle("rgba(255, 79, 0, 0.16)", "#ffd6c7")}>GitHub organization</span>;
}

function githubBadge(organization: FoundryOrganization) {
  if (organization.github.installationStatus === "connected") {
    return <span style={badgeStyle("rgba(46, 160, 67, 0.16)", "#b7f0c3")}>GitHub connected</span>;
  }
  if (organization.github.installationStatus === "reconnect_required") {
    return <span style={badgeStyle("rgba(255, 193, 7, 0.18)", "#ffe6a6")}>Reconnect required</span>;
  }
  return <span style={badgeStyle("rgba(255, 255, 255, 0.08)")}>Install GitHub App</span>;
}

function PageShell({
  user,
  title,
  eyebrow,
  description,
  children,
  actions,
  onSignOut,
}: {
  user: FoundryUser | null;
  title: string;
  eyebrow: string;
  description: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onSignOut?: () => void;
}) {
  return (
    <div style={appSurfaceStyle()}>
      <div style={topBarStyle()}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "42px",
              height: "42px",
              borderRadius: "14px",
              background: "linear-gradient(135deg, #ff4f00, #ff7a00)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              letterSpacing: "0.06em",
            }}
          >
            SA
          </div>
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", color: "#a1a1aa" }}>{eyebrow}</div>
            <div style={{ fontSize: "24px", fontWeight: 800 }}>{title}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {actions}
          {user ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "13px", fontWeight: 700 }}>{user.name}</div>
                <div style={{ fontSize: "12px", color: "#a1a1aa" }}>@{user.githubLogin}</div>
              </div>
              {onSignOut ? (
                <button type="button" onClick={onSignOut} style={secondaryButtonStyle()}>
                  Sign out
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div style={contentWrapStyle()}>
        <div style={{ maxWidth: "720px", color: "#d4d4d8", fontSize: "15px", lineHeight: 1.5 }}>{description}</div>
        {children}
      </div>
    </div>
  );
}

function StatCard({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div
      style={{
        ...cardStyle(),
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div style={{ fontSize: "12px", color: "#a1a1aa", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: "26px", fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: "13px", color: "#c4c4ca", lineHeight: 1.5 }}>{caption}</div>
    </div>
  );
}

function MemberRow({ member }: { member: FoundryOrganizationMember }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 120px",
        gap: "12px",
        padding: "12px 0",
        borderTop: "1px solid rgba(255, 255, 255, 0.08)",
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontWeight: 700 }}>{member.name}</div>
        <div style={{ color: "#a1a1aa", fontSize: "13px" }}>{member.email}</div>
      </div>
      <div style={{ color: "#d4d4d8", textTransform: "capitalize" }}>{member.role}</div>
      <div>
        <span
          style={badgeStyle(
            member.state === "active" ? "rgba(46, 160, 67, 0.16)" : "rgba(255, 193, 7, 0.18)",
            member.state === "active" ? "#b7f0c3" : "#ffe6a6",
          )}
        >
          {member.state}
        </span>
      </div>
    </div>
  );
}

export function MockSignInPage() {
  const client = useMockAppClient();
  const navigate = useNavigate();
  const mockAccount = {
    name: "Nathan",
    email: "nathan@acme.dev",
    githubLogin: "nathan",
    label: "Mock account for review",
  };

  return (
    <div style={appSurfaceStyle()}>
      <div style={{ ...contentWrapStyle(), justifyContent: "center", minHeight: "100dvh" }}>
        <div
          style={{
            ...cardStyle(),
            padding: "32px",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr)",
            gap: "28px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "18px", justifyContent: "center" }}>
            <span style={badgeStyle("rgba(255, 79, 0, 0.18)", "#ffd6c7")}>Mock Better Auth + GitHub OAuth</span>
            <div style={{ fontSize: "42px", lineHeight: 1.05, fontWeight: 900, maxWidth: "11ch" }}>Sign in and land directly in the org onboarding funnel.</div>
            <div style={{ fontSize: "16px", lineHeight: 1.6, color: "#d4d4d8", maxWidth: "56ch" }}>
              {isMockFrontendClient
                ? "This mock screen stands in for a basic GitHub OAuth sign-in page. After sign-in, the user moves into the separate organization selector and then the rest of the onboarding funnel."
                : "GitHub OAuth starts here. After the callback exchange completes, the app restores the signed-in session and continues into organization selection."}
            </div>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <div style={badgeStyle("rgba(255, 255, 255, 0.06)")}>
                <Github size={14} />
                GitHub sign-in
              </div>
              <div style={badgeStyle("rgba(255, 255, 255, 0.06)")}>
                <Building2 size={14} />
                Org selection
              </div>
              <div style={badgeStyle("rgba(255, 255, 255, 0.06)")}>
                <CreditCard size={14} />
                Hosted billing
              </div>
            </div>
          </div>
          <div
            style={{
              ...cardStyle(),
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "18px",
              justifyContent: "center",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "22px", fontWeight: 800 }}>Continue to Sandbox Agent</div>
              <div style={{ color: "#d4d4d8", lineHeight: 1.55 }}>
                {isMockFrontendClient
                  ? "This mock sign-in uses a single GitHub account so the org selection step remains the place where the user chooses their workspace."
                  : "This starts the live GitHub OAuth flow and restores the app session when the callback returns."}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  await client.signInWithGithub(isMockFrontendClient ? "user-nathan" : undefined);
                  if (isMockFrontendClient) {
                    await navigate({ to: "/organizations" });
                  }
                })();
              }}
              style={{
                ...primaryButtonStyle(),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                fontSize: "16px",
                padding: "14px 18px",
              }}
            >
              <Github size={18} />
              Sign in with GitHub
            </button>
            <div
              style={{
                borderRadius: "18px",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                background: "rgba(255, 255, 255, 0.03)",
                padding: "16px",
                display: "grid",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 800 }}>{mockAccount.name}</div>
                  <div style={{ color: "#a1a1aa", fontSize: "13px" }}>
                    @{mockAccount.githubLogin} · {mockAccount.email}
                  </div>
                </div>
                <span style={badgeStyle("rgba(24, 140, 255, 0.16)", "#b9d8ff")}>{isMockFrontendClient ? mockAccount.label : "Live GitHub identity"}</span>
              </div>
              <div style={{ color: "#a1a1aa", fontSize: "13px", lineHeight: 1.5 }}>
                {isMockFrontendClient
                  ? "Sign-in always lands as this single mock user. Organization choice happens on the next screen."
                  : "In remote mode this card is replaced by the live GitHub user once the OAuth callback completes."}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MockOrganizationSelectorPage() {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);
  const organizations: FoundryOrganization[] = eligibleOrganizations(snapshot);
  const navigate = useNavigate();
  const starterRepo = snapshot.onboarding.starterRepo;
  const starterRepoTarget = organizations.find((organization) => organization.kind === "organization") ?? organizations[0] ?? null;

  return (
    <PageShell
      user={user}
      title="Choose an organization"
      eyebrow="Onboarding"
      description="After GitHub sign-in, choose which personal workspace or GitHub organization to onboard. Organization workspaces simulate GitHub app installation, repository import, and shared billing."
      onSignOut={() => {
        void (async () => {
          await client.signOut();
          await navigate({ to: "/signin" });
        })();
      }}
    >
      <div
        style={{
          ...cardStyle(),
          padding: "22px",
          display: "grid",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Star size={18} />
              <div style={{ fontSize: "20px", fontWeight: 800 }}>Starter repo</div>
            </div>
            <div style={{ color: "#d4d4d8", lineHeight: 1.55, maxWidth: "72ch" }}>
              Star <strong>{starterRepo.repoFullName}</strong> before entering the main app, or skip it and continue onboarding. This keeps the starter-repo ask
              inside the funnel instead of interrupting the workspace later.
            </div>
          </div>
          {starterRepo.status === "starred" ? (
            <span style={badgeStyle("rgba(46, 160, 67, 0.16)", "#b7f0c3")}>Starred</span>
          ) : starterRepo.status === "skipped" ? (
            <span style={badgeStyle("rgba(255, 255, 255, 0.08)")}>Skipped for now</span>
          ) : (
            <span style={badgeStyle("rgba(255, 193, 7, 0.18)", "#ffe6a6")}>Optional</span>
          )}
        </div>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              if (!starterRepoTarget) {
                return;
              }
              void client.starStarterRepo(starterRepoTarget.id);
            }}
            style={primaryButtonStyle()}
            disabled={!starterRepoTarget || starterRepo.status === "starred"}
          >
            <Star size={15} />
            {starterRepo.status === "starred" ? "Repo starred" : "Star the Sandbox Agent repo"}
          </button>
          <button type="button" onClick={() => void client.skipStarterRepo()} style={secondaryButtonStyle()} disabled={starterRepo.status === "skipped"}>
            {starterRepo.status === "skipped" ? "Skipped" : "Maybe later"}
          </button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "18px" }}>
        {organizations.map((organization) => (
          <div
            key={organization.id}
            style={{
              ...cardStyle(),
              padding: "22px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
              <div>
                <div style={{ fontSize: "22px", fontWeight: 800 }}>{organization.settings.displayName}</div>
                <div style={{ color: "#a1a1aa", fontSize: "13px" }}>
                  {organization.settings.slug} · {organization.settings.primaryDomain}
                </div>
              </div>
              {statusBadge(organization)}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {githubBadge(organization)}
              <span style={badgeStyle("rgba(255, 255, 255, 0.06)")}>
                <CreditCard size={14} />
                {planCatalog[organization.billing.planId]!.label}
              </span>
            </div>
            <div style={{ color: "#d4d4d8", lineHeight: 1.55, minHeight: "70px" }}>
              {organization.kind === "personal"
                ? "Personal workspaces skip seat purchasing but still show the same onboarding and billing entry points."
                : "Organization onboarding includes GitHub repo import, seat accrual on first prompt, and billing controls for the shared workspace."}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px" }}>
              <StatCard
                label="Members"
                value={`${organization.members.length}`}
                caption={`${organization.members.filter((member) => member.state === "active").length} active`}
              />
              <StatCard label="Repos" value={`${organization.repoCatalog.length}`} caption={organization.github.lastSyncLabel} />
              <StatCard label="Seats" value={`${organization.seatAssignments.length}/${organization.billing.seatsIncluded}`} caption="Accrue on first prompt" />
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    await client.selectOrganization(organization.id);
                    await navigate({ to: workspacePath(organization) });
                  })();
                }}
                style={primaryButtonStyle()}
              >
                Continue as {organization.settings.displayName}
              </button>
              <button type="button" onClick={() => void navigate({ to: settingsPath(organization) })} style={secondaryButtonStyle()}>
                Organization settings
              </button>
              <button type="button" onClick={() => void navigate({ to: billingPath(organization) })} style={subtleButtonStyle()}>
                Billing
              </button>
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

export function MockOrganizationSettingsPage({ organization }: { organization: FoundryOrganization }) {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(organization.settings.displayName);
  const [slug, setSlug] = useState(organization.settings.slug);
  const [primaryDomain, setPrimaryDomain] = useState(organization.settings.primaryDomain);
  const seatCaption = useMemo(
    () => `${organization.seatAssignments.length} of ${organization.billing.seatsIncluded} seats already accrued`,
    [organization.billing.seatsIncluded, organization.seatAssignments.length],
  );
  const openWorkspace = () => {
    void (async () => {
      await client.selectOrganization(organization.id);
      await navigate({ to: workspacePath(organization) });
    })();
  };

  useEffect(() => {
    setDisplayName(organization.settings.displayName);
    setSlug(organization.settings.slug);
    setPrimaryDomain(organization.settings.primaryDomain);
  }, [organization.id, organization.settings.displayName, organization.settings.slug, organization.settings.primaryDomain]);

  return (
    <PageShell
      user={user}
      title={`${organization.settings.displayName} settings`}
      eyebrow="Organization"
      description={
        isMockFrontendClient
          ? "This mock settings surface covers the org profile, GitHub installation state, background repository sync controls, and the seat-accrual rule from the spec."
          : "This settings surface is backed by the app-shell actor and covers organization profile, GitHub installation state, repository sync controls, and seat accrual."
      }
      actions={
        <>
          <button type="button" onClick={() => void navigate({ to: "/organizations" })} style={secondaryButtonStyle()}>
            <ArrowLeft size={15} />
            Orgs
          </button>
          <button type="button" onClick={() => void navigate({ to: billingPath(organization) })} style={subtleButtonStyle()}>
            Billing
          </button>
          <button type="button" onClick={openWorkspace} style={primaryButtonStyle()}>
            Open workspace
          </button>
        </>
      }
      onSignOut={() => {
        void (async () => {
          await client.signOut();
          await navigate({ to: "/signin" });
        })();
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(320px, 0.9fr)", gap: "18px" }}>
        <div style={{ display: "grid", gap: "18px" }}>
          <div style={{ ...cardStyle(), padding: "24px", display: "grid", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
              <div>
                <div style={{ fontSize: "20px", fontWeight: 800 }}>Organization profile</div>
                <div style={{ color: "#a1a1aa", fontSize: "14px" }}>
                  {isMockFrontendClient ? "Mock org state persisted in the client package." : "Organization profile persisted in the app-shell backend."}
                </div>
              </div>
              {statusBadge(organization)}
            </div>
            <label style={{ display: "grid", gap: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700 }}>Display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} style={inputStyle()} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px" }}>
              <label style={{ display: "grid", gap: "8px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700 }}>Slug</span>
                <input value={slug} onChange={(event) => setSlug(event.target.value)} style={inputStyle()} />
              </label>
              <label style={{ display: "grid", gap: "8px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700 }}>Primary domain</span>
                <input value={primaryDomain} onChange={(event) => setPrimaryDomain(event.target.value)} style={inputStyle()} />
              </label>
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() =>
                  void client.updateOrganizationProfile({
                    organizationId: organization.id,
                    displayName,
                    slug,
                    primaryDomain,
                  })
                }
                style={primaryButtonStyle()}
              >
                Save settings
              </button>
              <button type="button" onClick={() => void client.triggerGithubSync(organization.id)} style={secondaryButtonStyle()}>
                Refresh repo sync
              </button>
            </div>
          </div>

          <div style={{ ...cardStyle(), padding: "24px", display: "grid", gap: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Github size={18} />
              <div style={{ fontSize: "20px", fontWeight: 800 }}>GitHub access</div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {githubBadge(organization)}
              <span style={badgeStyle("rgba(255, 255, 255, 0.06)")}>{organization.github.connectedAccount}</span>
            </div>
            <div style={{ color: "#d4d4d8", lineHeight: 1.55 }}>
              {organization.github.importedRepoCount} repos imported. Last sync: {organization.github.lastSyncLabel}
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button type="button" onClick={() => void client.reconnectGithub(organization.id)} style={secondaryButtonStyle()}>
                Reconnect GitHub
              </button>
              <button type="button" onClick={() => void client.triggerGithubSync(organization.id)} style={subtleButtonStyle()}>
                Retry sync
              </button>
            </div>
          </div>

          <div style={{ ...cardStyle(), padding: "24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <Users size={18} />
              <div style={{ fontSize: "20px", fontWeight: 800 }}>Members and roles</div>
            </div>
            <div style={{ color: "#a1a1aa", fontSize: "14px", marginBottom: "8px" }}>
              {isMockFrontendClient
                ? "Mock org membership feeds seat accrual and billing previews."
                : "Organization membership feeds seat accrual and billing state."}
            </div>
            {organization.members.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: "14px" }}>
          <StatCard label="Seat policy" value="First prompt" caption="Seats accrue when a member sends their first prompt in the workspace." />
          <StatCard label="Seat usage" value={`${organization.seatAssignments.length}`} caption={seatCaption} />
          <StatCard
            label="Default model"
            value={organization.settings.defaultModel}
            caption="Shown here to match the expected org-level configuration surface."
          />
        </div>
      </div>
    </PageShell>
  );
}

export function MockOrganizationBillingPage({ organization }: { organization: FoundryOrganization }) {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);
  const navigate = useNavigate();
  const hasStripeCustomer = organization.billing.stripeCustomerId.trim().length > 0;
  const effectivePlanId: FoundryBillingPlanId = hasStripeCustomer ? organization.billing.planId : "free";
  const effectiveSeatsIncluded = hasStripeCustomer ? organization.billing.seatsIncluded : 1;
  const openWorkspace = () => {
    void (async () => {
      await client.selectOrganization(organization.id);
      await navigate({ to: workspacePath(organization) });
    })();
  };

  return (
    <PageShell
      user={user}
      title={`${organization.settings.displayName} billing`}
      eyebrow="Stripe Billing"
      description={
        isMockFrontendClient
          ? "This mock page covers plan selection, hosted checkout entry, renewal controls, seat usage, and invoice history. It is the reviewable UI surface for Milestone 2 billing without wiring the real Stripe backend yet."
          : "This billing surface drives live Stripe checkout, portal management, renewal controls, seat usage, and invoice history from the persisted organization billing model."
      }
      actions={
        <>
          <button type="button" onClick={() => void navigate({ to: settingsPath(organization) })} style={secondaryButtonStyle()}>
            Org settings
          </button>
          <button type="button" onClick={openWorkspace} style={primaryButtonStyle()}>
            Open workspace
          </button>
        </>
      }
      onSignOut={() => {
        void (async () => {
          await client.signOut();
          await navigate({ to: "/signin" });
        })();
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "14px" }}>
        <StatCard label="Current plan" value={planCatalog[effectivePlanId]!.label} caption={organization.billing.status.replaceAll("_", " ")} />
        <StatCard
          label="Seats used"
          value={`${organization.seatAssignments.length}/${effectiveSeatsIncluded}`}
          caption="Seat accrual happens on first prompt in the workspace."
        />
        <StatCard label="Renewal" value={formatDate(organization.billing.renewalAt)} caption={`Payment method: ${organization.billing.paymentMethodLabel}`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "18px" }}>
        {(Object.entries(planCatalog) as Array<[FoundryBillingPlanId, (typeof planCatalog)[FoundryBillingPlanId]]>).map(([planId, plan]) => {
          const isCurrent = effectivePlanId === planId;
          return (
            <div key={planId} style={{ ...cardStyle(), padding: "22px", display: "grid", gap: "14px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                <div>
                  <div style={{ fontSize: "22px", fontWeight: 800 }}>{plan.label}</div>
                  <div style={{ color: "#a1a1aa", fontSize: "13px" }}>{plan.seats}</div>
                </div>
                {isCurrent ? <span style={badgeStyle("rgba(46, 160, 67, 0.16)", "#b7f0c3")}>Current</span> : null}
              </div>
              <div style={{ fontSize: "34px", fontWeight: 900 }}>{plan.price}</div>
              <div style={{ color: "#d4d4d8", lineHeight: 1.55, minHeight: "70px" }}>{plan.summary}</div>
              <button
                type="button"
                onClick={() => (isCurrent ? void navigate({ to: billingPath(organization) }) : void navigate({ to: checkoutPath(organization, planId) }))}
                style={isCurrent ? secondaryButtonStyle() : primaryButtonStyle()}
              >
                {isCurrent ? "Current plan" : `Choose ${plan.label}`}
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(320px, 1.1fr)", gap: "18px" }}>
        <div style={{ ...cardStyle(), padding: "24px", display: "grid", gap: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <ShieldCheck size={18} />
            <div style={{ fontSize: "20px", fontWeight: 800 }}>Subscription controls</div>
          </div>
          <div style={{ color: "#d4d4d8", lineHeight: 1.55 }}>
            Stripe customer {organization.billing.stripeCustomerId || "pending"}.{" "}
            {isMockFrontendClient
              ? "This mock screen intentionally mirrors a hosted billing portal entry point and the in-product summary beside it."
              : hasStripeCustomer
                ? "Use the portal for payment method management and invoices, while in-product controls keep renewal state visible in the app shell."
                : "Complete checkout first, then use the portal and renewal controls once Stripe has created the customer and subscription."}
          </div>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {hasStripeCustomer ? (
              organization.billing.status === "scheduled_cancel" ? (
                <button type="button" onClick={() => void client.resumeSubscription(organization.id)} style={primaryButtonStyle()}>
                  Resume subscription
                </button>
              ) : (
                <button type="button" onClick={() => void client.cancelScheduledRenewal(organization.id)} style={secondaryButtonStyle()}>
                  Cancel at period end
                </button>
              )
            ) : (
              <button type="button" onClick={() => void navigate({ to: checkoutPath(organization, "team") })} style={primaryButtonStyle()}>
                Start Team checkout
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void (isMockFrontendClient
                  ? navigate({ to: checkoutPath(organization, effectivePlanId) })
                  : hasStripeCustomer
                    ? client.openBillingPortal(organization.id)
                    : navigate({ to: checkoutPath(organization, "team") }))
              }
              style={subtleButtonStyle()}
            >
              {isMockFrontendClient ? "Open hosted checkout mock" : hasStripeCustomer ? "Open Stripe portal" : "Go to checkout"}
            </button>
          </div>
        </div>

        <div style={{ ...cardStyle(), padding: "24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <BadgeCheck size={18} />
            <div style={{ fontSize: "20px", fontWeight: 800 }}>Invoices</div>
          </div>
          <div style={{ color: "#a1a1aa", fontSize: "14px", marginBottom: "8px" }}>Recent hosted billing activity for review.</div>
          {organization.billing.invoices.length === 0 ? (
            <div style={{ color: "#d4d4d8" }}>No invoices yet.</div>
          ) : (
            organization.billing.invoices.map((invoice) => (
              <div
                key={invoice.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) 120px 90px",
                  gap: "12px",
                  alignItems: "center",
                  padding: "12px 0",
                  borderTop: "1px solid rgba(255, 255, 255, 0.08)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>{invoice.label}</div>
                  <div style={{ fontSize: "13px", color: "#a1a1aa" }}>{invoice.issuedAt}</div>
                </div>
                <div style={{ fontWeight: 700 }}>${invoice.amountUsd}</div>
                <div>
                  <span
                    style={badgeStyle(
                      invoice.status === "paid" ? "rgba(46, 160, 67, 0.16)" : "rgba(255, 193, 7, 0.18)",
                      invoice.status === "paid" ? "#b7f0c3" : "#ffe6a6",
                    )}
                  >
                    {invoice.status}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </PageShell>
  );
}

export function MockHostedCheckoutPage({ organization, planId }: { organization: FoundryOrganization; planId: FoundryBillingPlanId }) {
  const client = useMockAppClient();
  const snapshot = useMockAppSnapshot();
  const user = activeMockUser(snapshot);
  const navigate = useNavigate();
  const plan = planCatalog[planId]!;

  return (
    <PageShell
      user={user}
      title={`Checkout ${plan.label}`}
      eyebrow="Hosted Checkout"
      description={
        isMockFrontendClient
          ? "This is the mock hosted Stripe step. Completing checkout updates the org billing state in the client package and returns the reviewer to the billing screen."
          : "This hands off to a live Stripe Checkout session. After payment succeeds, the backend finalizes the session and routes back into the billing screen."
      }
      actions={
        <button type="button" onClick={() => void navigate({ to: billingPath(organization) })} style={secondaryButtonStyle()}>
          <ArrowLeft size={15} />
          Back to billing
        </button>
      }
      onSignOut={() => {
        void (async () => {
          await client.signOut();
          await navigate({ to: "/signin" });
        })();
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.95fr) minmax(320px, 1.05fr)", gap: "18px" }}>
        <div style={{ ...cardStyle(), padding: "24px", display: "grid", gap: "14px" }}>
          <div style={{ fontSize: "20px", fontWeight: 800 }}>Order summary</div>
          <div style={{ color: "#d4d4d8", lineHeight: 1.55 }}>
            {organization.settings.displayName} is checking out on the {plan.label} plan.
          </div>
          <div style={{ display: "grid", gap: "10px" }}>
            <CheckoutLine label="Plan" value={plan.label} />
            <CheckoutLine label="Price" value={plan.price} />
            <CheckoutLine label="Included seats" value={plan.seats} />
            <CheckoutLine label="Payment method" value="Visa ending in 4242" />
          </div>
        </div>
        <div style={{ ...cardStyle(), padding: "24px", display: "grid", gap: "16px" }}>
          <div style={{ fontSize: "20px", fontWeight: 800 }}>Mock card details</div>
          <div style={{ display: "grid", gap: "12px" }}>
            <label style={{ display: "grid", gap: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700 }}>Cardholder</span>
              <input value={organization.settings.displayName} readOnly style={inputStyle()} />
            </label>
            <label style={{ display: "grid", gap: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700 }}>Card number</span>
              <input value="4242 4242 4242 4242" readOnly style={inputStyle()} />
            </label>
          </div>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await client.completeHostedCheckout(organization.id, planId);
                if (isMockFrontendClient) {
                  await navigate({ to: billingPath(organization), replace: true });
                }
              })();
            }}
            style={primaryButtonStyle()}
          >
            {isMockFrontendClient ? "Complete checkout" : "Continue to Stripe"}
          </button>
        </div>
      </div>
    </PageShell>
  );
}

function CheckoutLine({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "12px 0",
        borderTop: "1px solid rgba(255, 255, 255, 0.08)",
      }}
    >
      <div style={{ color: "#a1a1aa" }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    borderRadius: "14px",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    background: "rgba(255, 255, 255, 0.04)",
    color: "#ffffff",
    padding: "12px 14px",
    outline: "none",
  };
}
