import { useEffect, useState, type FormEvent } from "react";
import { connectProject, createPairingCode, fetchEvents, fetchProjects, type Project, type StoredEvent } from "./api";
import { supabase, type Session } from "./supabase";

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [repoId, setRepoId] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) {
      setProject(null);
      setEvents([]);
      return;
    }
    void fetchProjects(token)
      .then((body) => {
        setProject(body.projects[0] ?? null);
        setError(null);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load the project.");
      });
  }, [session]);

  useEffect(() => {
    const token = session?.access_token;
    if (!token || !project) {
      setEvents([]);
      return;
    }
    void fetchEvents(token, project.id)
      .then((body) => setEvents(body.events))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load events.");
      });
  }, [session, project]);

  async function signIn() {
    if (!supabase) {
      setError("Supabase URL and anon key are missing from the environment.");
      return;
    }
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: window.location.origin },
    });
    if (signInError) {
      setError(signInError.message);
    }
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  async function onConnect(event: FormEvent) {
    event.preventDefault();
    const token = session?.access_token;
    if (!token) {
      return;
    }
    const parsedRepoId = Number(repoId);
    if (!owner || !name || !Number.isInteger(parsedRepoId)) {
      setError("Enter the GitHub owner, repository name, and numeric repository id.");
      return;
    }
    try {
      const body = await connectProject(token, { owner, name, repoId: parsedRepoId });
      setProject(body.project);
      setError(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not connect the repository.");
    }
  }

  if (!ready) {
    return <main className="page">Loading…</main>;
  }

  return (
    <main className="page">
      <h1>Automatic Project Map</h1>
      <p>Connect one GitHub repository. Events from that repository and from local sessions show up here.</p>
      {error ? <p className="error">{error}</p> : null}
      {!session ? (
        <button type="button" onClick={() => void signIn()}>
          Sign in with GitHub
        </button>
      ) : (
        <section>
          <p>Signed in as {session.user.email ?? session.user.id}</p>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
          {project ? (
            <section>
              <h2>
                {project.owner}/{project.name}
              </h2>
              <p>Tracking started {project.trackingStartedAt}</p>
              <h3>Local helper</h3>
              <p>Start the helper, then pair it with a code from this signed-in browser. Folder selection stays on the helper.</p>
              <button
                type="button"
                onClick={() => {
                  const token = session.access_token;
                  void createPairingCode(token, project.id)
                    .then((body) => {
                      setPairingCode(body.code);
                      setError(null);
                    })
                    .catch((reason: unknown) => {
                      setError(reason instanceof Error ? reason.message : "Could not create a pairing code.");
                    });
                }}
              >
                Create pairing code
              </button>
              {pairingCode ? (
                <p>
                  Pairing code: <code>{pairingCode}</code>
                </p>
              ) : null}
              <h3>Events</h3>
              {events.length === 0 ? (
                <p>No events yet. GitHub webhooks and eligible local sessions will appear here.</p>
              ) : (
                <ul>
                  {events.map((item) => (
                    <li key={item.eventId}>
                      {item.details.kind} from {item.source} at {item.occurredAt}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <form onSubmit={(event) => void onConnect(event)}>
              <h2>Connect one repository</h2>
              <label>
                Owner
                <input value={owner} onChange={(event) => setOwner(event.target.value)} />
              </label>
              <label>
                Repository
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label>
                Repository id
                <input value={repoId} onChange={(event) => setRepoId(event.target.value)} />
              </label>
              <button type="submit">Connect</button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}

export default App;
