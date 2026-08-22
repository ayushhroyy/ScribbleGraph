import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Home from "./pages/Home.jsx";
import Capture from "./pages/Capture.jsx";
import Session from "./pages/Session.jsx";
import Note from "./pages/Note.jsx";
import GraphPage from "./pages/GraphPage.jsx";
import Ask from "./pages/Ask.jsx";
import Quiz from "./pages/Quiz.jsx";
import Flashcards from "./pages/Flashcards.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/capture" element={<Capture />} />
        <Route path="/session/:id" element={<Session />} />
        <Route path="/note/:id" element={<Note />} />
        <Route path="/graph" element={<GraphPage />} />
        <Route path="/ask" element={<Ask />} />
        <Route path="/quiz" element={<Quiz />} />
        <Route path="/flashcards" element={<Flashcards />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
