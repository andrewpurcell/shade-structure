import "./index.css";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

app.innerHTML = `
  <main class="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-8">
    <h1 class="text-4xl font-bold text-slate-800 tracking-tight">
      Shade Structure
    </h1>
    <p class="mt-4 text-slate-600 text-lg">
      TypeScript + Tailwind SPA
    </p>
  </main>
`;
