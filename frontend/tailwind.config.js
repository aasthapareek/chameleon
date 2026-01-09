/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                background: "#1e1e1e",
                panel: "#252526",
                border: "#3d3d3d",
                highlight: "#007fd4",
            },
            fontFamily: {
                mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
            }
        },
    },
    plugins: [],
}
