import { z } from "zod";

export const USERNAME_REGEX = /^[A-Za-z0-9]+$/;

export const USERNAME_SCHEMA = z
  .string()
  .min(3)
  .max(32)
  .regex(USERNAME_REGEX, "Username must contain only letters and numbers");
