import { NavLink, useNavigate } from "react-router-dom";

const tabs = [
  { to: "/", label: "Home", end: true, icon: HomeIcon },
  { to: "/graph", label: "Graph", end: false, icon: GraphIcon },
  { to: "/capture", label: "Capture", center: true, icon: CameraIcon },
  { to: "/ask", label: "Ask", end: false, icon: ChatIcon },
  { to: "/flashcards", label: "Cards", end: false, icon: CardsIcon },
];

export default function Nav() {
  const nav = useNavigate();
  return (
    <>
      {/* desktop top bar */}
      <header className="hidden md:block border-b border-white/[0.06] sticky top-0 z-40 bg-[#09090b]/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <NavLink to="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="font-semibold tracking-tight text-[15px]">ScribbleGraph</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {tabs
              .filter((t) => !t.center)
              .map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    `px-3.5 py-2 rounded-lg text-[13.5px] transition-colors ${
                      isActive ? "text-white bg-white/[0.07] font-medium" : "text-zinc-500 hover:text-zinc-200"
                    }`
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            <button onClick={() => nav("/capture")} className="btn btn-primary ml-3 !py-2">
              <CameraIcon /> Capture
            </button>
          </nav>
        </div>
      </header>

      {/* mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 pb-safe border-t border-white/[0.06] bg-[#0c0c0e]/90 backdrop-blur-xl">
        <div className="grid grid-cols-5 h-16 items-center px-2">
          {tabs.map((t) =>
            t.center ? (
              <button key={t.to} onClick={() => nav(t.to)} className="flex justify-center">
                <span
                  className="w-12 h-12 rounded-2xl bg-[#7c6cff] flex items-center justify-center -mt-6"
                  style={{ boxShadow: "0 8px 24px rgba(124,108,255,.4)" }}
                >
                  <CameraIcon size={22} />
                </span>
              </button>
            ) : (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 py-1.5 transition-colors ${
                    isActive ? "text-[#a99fff]" : "text-zinc-600"
                  }`
                }
              >
                <t.icon size={20} />
                <span className="text-[10px] font-medium">{t.label}</span>
              </NavLink>
            )
          )}
        </div>
      </nav>
    </>
  );
}

function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 100 100">
      <circle cx="30" cy="36" r="13" fill="#7C6CFF" />
      <circle cx="71" cy="62" r="10" fill="#4CC9F0" />
      <path d="M39 44 L63 56" stroke="#6b6b74" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function HomeIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" /> <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}
function GraphIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="6" cy="6" r="2.6" /> <circle cx="18" cy="8" r="2.6" /> <circle cx="12" cy="18" r="2.6" />
      <path d="M8.3 7 15.4 7.9M7 8.4l3.8 7.3M16.8 10.4l-3.3 5.4" strokeLinecap="round" />
    </svg>
  );
}
function CameraIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l2-3h6l2 3h3v12H4z" /> <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}
function ChatIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H4l2.5-3A8 8 0 1 1 21 12z" />
    </svg>
  );
}
function CardsIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="14" height="12" rx="2.5" /> <path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}
