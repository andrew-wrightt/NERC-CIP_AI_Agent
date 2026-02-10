import express from "express";
import { findUserByUsername, verifyPassword, touchLastLogin } from "./auth.service.js";

export const authRouter = express.Router();

authRouter.post("/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  const user = findUserByUsername(username);
  if (!user) return res.status(401).json({ error: "invalid credentials" });

  const ok = verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  req.session.user = { id: user.id, username: user.username, role: user.role };
  touchLastLogin(user.id);

  return res.json({ ok: true, user: req.session.user });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "logout failed" });
    res.clearCookie("sid");
    return res.json({ ok: true });
  });
});

authRouter.get("/me", (req, res) => {
  return res.json({ user: req.session?.user ?? null });
});
