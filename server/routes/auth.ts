import { Router } from "express";
import { getCsrfToken, issueSessionCookie } from "../security/auth.js";
import { SESSION_AUTH_TOKEN } from "../config/runtime.js";

const router = Router();

router.get("/auth/session", (req, res) => {
  issueSessionCookie(req, res);
  res.json({
    csrf_token: getCsrfToken(),
    authenticated: true,
  });
});

export default router;
