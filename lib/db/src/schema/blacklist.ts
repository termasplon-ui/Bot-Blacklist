import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

export const blacklistTable = pgTable("blacklist", {
  id: serial("id").primaryKey(),
  nickname: text("nickname").notNull(),
  reason: text("reason").notNull(),
  days: integer("days").notNull().default(0),
  amnesty: boolean("amnesty").notNull().default(false),
  issuedBy: text("issued_by").notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
  guildId: text("guild_id").notNull(),
  active: boolean("active").notNull().default(true),
});

export type Blacklist = typeof blacklistTable.$inferSelect;
export type InsertBlacklist = typeof blacklistTable.$inferInsert;
