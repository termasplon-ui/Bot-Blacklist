import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const warningsTable = pgTable("warnings", {
  id: serial("id").primaryKey(),
  nickname: text("nickname").notNull(),
  reason: text("reason").notNull(),
  issuedBy: text("issued_by").notNull(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  guildId: text("guild_id").notNull(),
  active: boolean("active").notNull().default(true),
});

export type Warning = typeof warningsTable.$inferSelect;
export type InsertWarning = typeof warningsTable.$inferInsert;
