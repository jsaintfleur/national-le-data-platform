import { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { ErrorState, Loading } from './components/primitives';

const Overview = lazy(() => import('./routes/Overview'));
const MapExplorer = lazy(() => import('./routes/MapExplorer'));
const Agencies = lazy(() => import('./routes/Agencies'));
const AgencyProfile = lazy(() => import('./routes/AgencyProfile'));
const Compare = lazy(() => import('./routes/Compare'));
const States = lazy(() => import('./routes/States'));
const StateProfile = lazy(() => import('./routes/StateProfile'));
const Quality = lazy(() => import('./routes/Quality'));
const Methodology = lazy(() => import('./routes/Methodology'));
const Sources = lazy(() => import('./routes/Sources'));

/**
 * One failed section must not take down a page. Every route is wrapped, so a profile whose
 * peer panel errors still shows its snapshot, trend and provenance.
 */
class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="card">
          <ErrorState error={this.state.error} retry={() => this.setState({ error: null })} />
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <Shell>
      <Boundary>
        <Suspense fallback={<div className="card"><Loading rows={4} /></div>}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/map" element={<MapExplorer />} />
            <Route path="/agencies" element={<Agencies />} />
            <Route path="/agencies/:id" element={<AgencyProfile />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/states" element={<States />} />
            <Route path="/states/:code" element={<StateProfile />} />
            <Route path="/quality" element={<Quality />} />
            <Route path="/methodology" element={<Methodology />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="*" element={
              <div className="card">
                <div className="state-block">
                  <div className="title">Page not found</div>
                  <div>That route does not exist in this build.</div>
                </div>
              </div>
            } />
          </Routes>
        </Suspense>
      </Boundary>
    </Shell>
  );
}
