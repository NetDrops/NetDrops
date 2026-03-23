/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#007aff",
      },
      boxShadow: {
        subtle: "0 1px 4px rgba(0,0,0,0.1)",
      },
    },
  },
  plugins: [],
}

