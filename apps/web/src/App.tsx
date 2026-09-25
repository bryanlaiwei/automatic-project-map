import { useCallback, useEffect, useState } from "react";
import { ApiError, api, errorMessage, type Me, type Project } from "./api";
import { Onboarding } from "./components/Onboarding";
import { SignIn } from "./components/SignIn";
import { ToastProvider } from "./components/toast";
import { Button, ErrorNote, Spinner } from "./components/ui";
import { Workspace } from "./components/Workspace";
import { supabase, type Session } from "./supabase";

const projectKey = "apm:project";

type Account = { me: Me; projects: Project[] };

function AppContent() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() => window.localStorage.getItem(projectKey));
  const token = session?.access_token ?? null;

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const loadAccount = useCallback(async () => {
    if (!token) {
      setAccount(null);
      return;
    }
    try {
      const [me, list] = await Promise.all([api.me(token), api.projects(token)]);
      setAccount({ me, projects: list.projects });
      setError(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        await supabase?.auth.signOut();
        return;
      }
      setError(errorMessage(reason, "Could not reach the server."));
    }
  }, [token]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  const chooseProject = useCallback((id: string | null) => {
    setProjectId(id);
    if (id) {
      window.localStorage.setItem(projectKey, id);
    } else {
      window.localStorage.removeItem(projectKey);
    }
  }, []);

  const projectGone = useCallback(() => {
    chooseProject(null);
    void loadAccount();
  }, [chooseProject, loadAccount]);

  async function signIn(): Promise<string | null> {
    if (!supabase) {
      return "Supabase URL and anon key are missing from the environment.";
    }
    const { error: signInError } = await supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: window.location.origin } });
    return signInError?.message ?? null;
  }

  async function signOut() {
    chooseProject(null);
    await supabase?.auth.signOut();
  }

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!session || !token) {
    return <SignIn onSignIn={signIn} />;
  }
  if (!account) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        {error ? (
          <>
            <div className="max-w-sm">
              <ErrorNote>{error}</ErrorNote>
            </div>
            <Button onClick={() => void loadAccount()}>Try again</Button>
          </>
        ) : (
          <Spinner className="size-6" />
        )}
      </div>
    );
  }

  const project = account.projects.find((entry) => entry.id === projectId) ?? account.projects[0];
  if (!project) {
    return (
      <Onboarding
        token={token}
        me={account.me}
        onConnected={(id) => {
          chooseProject(id);
          void loadAccount();
        }}
        onJoined={(id) => {
          chooseProject(id);
          void loadAccount();
        }}
        onSignOut={() => void signOut()}
      />
    );
  }
  return (
    <Workspace
      key={project.id}
      token={token}
      me={account.me.user}
      invitations={account.me.invitations}
      project={project}
      projects={account.projects}
      onSwitchProject={chooseProject}
      onJoined={(id) => {
        chooseProject(id);
        void loadAccount();
      }}
      onSignOut={() => void signOut()}
      onProjectGone={projectGone}
    />
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
