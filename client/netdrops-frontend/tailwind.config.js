module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#007AFF",
        background: "#F9F9F9",
      },
      fontFamily: {
        sans: ["Helvetica Neue", "Apple SD Gothic Neo", "sans-serif"],
      },
      borderRadius: {
        xl: "1rem",
      },
      boxShadow: {
        subtle: "0 1px 3px rgba(0, 0, 0, 0.1)",
      },
    },
  },
  plugins: [],
};
