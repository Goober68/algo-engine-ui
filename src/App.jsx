import { Routes, Route, NavLink, Navigate, useParams, useLocation, useMatch, Outlet } from 'react-router-dom';
import RunnersList from './routes/RunnersList';
import RunnerOverview from './routes/RunnerOverview';
import SlotView from './routes/SlotView';
import RunBrowser from './routes/RunBrowser';
import Settings from './routes/Settings';
import { useRunMeta, useRunners, useRunnersRegistry, DATA_MODE, DATA_SOURCE_URL } from './data/MockDataProvider';

export default function App() {
  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <TopHeader />
      <NavRow2 />
      <NavRow3 />
      <main className="flex-1 min-h-0 flex flex-col">
        <Routes>
          <Route path="/"                 element={<RunnersList />} />
          <Route path="/r/:id"            element={<Outlet />}>
            <Route index                  element={<RunnerOverview />} />
            <Route path="s/:n"            element={<SlotView />} />
          </Route>
          <Route path="/runs"             element={<RunBrowser />} />
          <Route path="/settings"         element={<Settings />} />
          <Route path="*"                 element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// Title + top-level tabs + mode badge — all in one row.
function TopHeader() {
  const reg = useRunnersRegistry();
  return (
    <header className="flex items-center gap-3 px-3 py-1 bg-panel border-b border-border">
      <h1 className="text-sm font-semibold text-accent">algo-engine</h1>
      {reg && (
        <span className="text-[11px] text-muted tnum">{reg.host}</span>
      )}
      <nav className="flex gap-0.5 text-xs ml-3">
        <Tab1 to="/" match={['/', '/r/*']}>Runners</Tab1>
        <Tab1 to="/runs">Runs</Tab1>
        <Tab1 to="/settings">Settings</Tab1>
      </nav>
      <span className="ml-auto text-[11px] text-muted tnum">
        {DATA_MODE === 'coord'
          ? <>coord · <span className="text-text">{DATA_SOURCE_URL}</span></>
          : <>mock</>}
      </span>
    </header>
  );
}

// Row 2 — runner tabs. Visible only when in Runners mode (path is `/`
// or `/r/...`). Hidden on Runs/Settings.
function NavRow2() {
  const location = useLocation();
  const runners = useRunners();
  const matchRunner = useMatch('/r/:id/*');
  const matchRunnerExact = useMatch('/r/:id');
  const activeId = matchRunner?.params.id || matchRunnerExact?.params.id;
  const inRunnersMode = location.pathname === '/' || location.pathname.startsWith('/r/');
  if (!inRunnersMode) return null;
  return (
    <div className="flex items-center gap-1 px-3 py-0.5 bg-panel2 border-b border-border text-xs">
      {!runners ? (
        <span className="text-muted">loading runners…</span>
      ) : (
        <>
          {runners.map(r => (
            <Tab2 key={r.id} to={`/r/${r.id}`} active={activeId === r.id}>
              <StatusDot status={r.status} />
              {r.label}
            </Tab2>
          ))}
          <button
            onClick={() => alert('+ Runner — mock; wired in Phase 2')}
            className="ml-2 px-2 py-0.5 rounded text-muted hover:text-text"
          >
            + Runner
          </button>
        </>
      )}
    </div>
  );
}

// Row 3 — slot tabs within the selected runner. Visible only when a
// runner is selected.
function NavRow3() {
  const matchRunner = useMatch('/r/:id/*');
  const matchRunnerExact = useMatch('/r/:id');
  const matchSlot = useMatch('/r/:id/s/:n');
  const id = matchRunner?.params.id || matchRunnerExact?.params.id;
  if (!id) return null;
  return <NavRow3Body runnerId={id} activeSlot={matchSlot?.params.n} />;
}

function NavRow3Body({ runnerId, activeSlot }) {
  const meta = useRunMeta(runnerId);
  return (
    <div className="flex items-center gap-1 px-3 py-0.5 bg-bg border-b border-border text-xs">
      <Tab3 to={`/r/${runnerId}`} active={activeSlot === undefined}>Fleet</Tab3>
      {meta?.slots.map(s => (
        <Tab3
          key={s.slot_idx}
          to={`/r/${runnerId}/s/${s.slot_idx}`}
          active={activeSlot !== undefined && parseInt(activeSlot, 10) === s.slot_idx}
        >
          Slot {s.slot_idx}
          <span className="text-muted ml-1">· {s.account}</span>
        </Tab3>
      ))}
    </div>
  );
}

// ─── Tab styles per row ────────────────────────────────────────────
function Tab1({ to, match, children }) {
  const location = useLocation();
  const isActive = (match || [to]).some(p =>
    p === to ? location.pathname === to
             : new RegExp('^' + p.replace('*', '.*') + '$').test(location.pathname)
  );
  return (
    <NavLink
      to={to}
      className={
        'px-4 py-1.5 rounded-t font-semibold ' +
        (isActive
          ? 'bg-panel2 text-accent border-b-2 border-accent'
          : 'text-muted hover:text-text')
      }
    >
      {children}
    </NavLink>
  );
}

function Tab2({ to, active, children }) {
  return (
    <NavLink
      to={to}
      className={
        'px-3 py-1 rounded inline-flex items-center gap-2 ' +
        (active
          ? 'bg-bg border border-accent text-text'
          : 'bg-panel border border-border text-muted hover:text-text hover:border-muted')
      }
    >
      {children}
    </NavLink>
  );
}

function Tab3({ to, active, children }) {
  return (
    <NavLink
      to={to}
      className={
        'px-2.5 py-0.5 rounded ' +
        (active
          ? 'bg-panel border border-accent text-text'
          : 'text-muted hover:text-text hover:bg-panel')
      }
    >
      {children}
    </NavLink>
  );
}

function StatusDot({ status }) {
  const map = { live: 'bg-long', shadow: 'bg-accent', offline: 'bg-muted' };
  return <span className={`w-1.5 h-1.5 rounded-full ${map[status] || 'bg-muted'}`} />;
}
