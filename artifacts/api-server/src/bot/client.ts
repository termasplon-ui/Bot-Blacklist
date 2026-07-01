import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  Colors,
  type Interaction,
  type ModalSubmitInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { db } from "@workspace/db";
import { blacklistTable, warningsTable } from "@workspace/db";
import { eq, and, desc, lt } from "drizzle-orm";
import { logger } from "../lib/logger";

const TOKEN = process.env["DISCORD_BOT_TOKEN"];
const CLIENT_ID = process.env["DISCORD_CLIENT_ID"];

export const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Permission check ─────────────────────────────────────────────────────────

const ALLOWED_ROLE_NAME = "🛡️ Blacklist Checker 🛡 Семья";

function hasModPermission(member: GuildMember | null): boolean {
  if (!member) return false;
  return member.roles.cache.some((role) => role.name === ALLOWED_ROLE_NAME);
}

async function denyAccess(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
): Promise<void> {
  await interaction.reply({
    content: `⛔ У вас нет прав для использования этой команды.\nТребуется роль **${ALLOWED_ROLE_NAME}**.`,
    ephemeral: true,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Parse "DD.MM.YYYY | N" → { issuedDate, days, endDate } or null */
function parseDateAndDays(raw: string): { issuedDate: Date; days: number; endDate: Date | null } | null {
  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length < 2) return null;
  const dateParts = parts[0]!.split(".").map(Number);
  if (dateParts.length !== 3 || dateParts.some(isNaN)) return null;
  const [day, month, year] = dateParts as [number, number, number];
  const issuedDate = new Date(year, month - 1, day);
  if (isNaN(issuedDate.getTime())) return null;
  const days = parseInt(parts[1]!, 10);
  if (isNaN(days) || days < 0) return null;
  const endDate = days === 0 ? null : (() => {
    const d = new Date(issuedDate);
    d.setDate(d.getDate() + days);
    return d;
  })();
  return { issuedDate, days, endDate };
}

function calcPercent(issuedAt: Date, days: number): string {
  if (days === 0) return "Навсегда ♾️";
  const total = days * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - issuedAt.getTime();
  const remaining = Math.max(0, total - elapsed);
  const pct = Math.round((remaining / total) * 100);
  const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
  return `${bar} ${pct}% осталось`;
}

// ─── Command registration ─────────────────────────────────────────────────────

async function registerCommands(clientId: string, token: string): Promise<void> {
  const rest = new REST().setToken(token);

  const commands = [
    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("🛑 Выдать чёрный список игроку семьи"),

    new SlashCommandBuilder()
      .setName("bl")
      .setDescription("🛑 Просмотр чёрного списка игрока семьи")
      .addStringOption((opt) =>
        opt.setName("nickname").setDescription("Никнейм игрока").setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("unblacklist")
      .setDescription("✅ Снять чёрный список с игрока семьи")
      .addStringOption((opt) =>
        opt.setName("nickname").setDescription("Никнейм игрока").setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("⚠️ Выдать предупреждение игроку семьи (7 дней)"),

    new SlashCommandBuilder()
      .setName("unwarn")
      .setDescription("🟢 Снять предупреждение с игрока")
      .addStringOption((opt) =>
        opt.setName("nickname").setDescription("Никнейм игрока").setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("history")
      .setDescription("📜 История чёрного списка и предупреждений игрока")
      .addStringOption((opt) =>
        opt.setName("nickname").setDescription("Никнейм игрока").setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("staff")
      .setDescription("📌 Актуальный список старшего состава / лидера семьи"),
  ].map((c) => c.toJSON());

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Discord slash commands registered globally");
}

// ─── /blacklist ───────────────────────────────────────────────────────────────

async function handleBlacklistCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const today = formatDate(new Date());

  const modal = new ModalBuilder()
    .setCustomId("blacklist_modal")
    .setTitle("🛑 Чёрный список семьи 🛑");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("nickname")
        .setLabel("Никнейм игрока")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Введите никнейм"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Причина чёрного списка")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder("Укажите причину"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("date_days")
        .setLabel("Дата выдачи | Кол-во дней (0 = навсегда)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(`Пример: ${today} | 30`),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("amnesty")
        .setLabel("Возможна ли амнистия? (да / нет)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("да или нет"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("issued_by")
        .setLabel("Кто выдал ЧС")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Введите никнейм выдавшего"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleBlacklistModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const nickname  = interaction.fields.getTextInputValue("nickname").trim();
  const reason    = interaction.fields.getTextInputValue("reason").trim();
  const dateDays  = interaction.fields.getTextInputValue("date_days").trim();
  const amnestyRaw = interaction.fields.getTextInputValue("amnesty").trim().toLowerCase();
  const issuedBy  = interaction.fields.getTextInputValue("issued_by").trim();
  const guildId   = interaction.guildId ?? "global";

  const parsed = parseDateAndDays(dateDays);
  if (!parsed) {
    await interaction.reply({
      content: "❌ Неверный формат даты и дней.\nИспользуйте: `ДД.ММ.ГГГГ | дней` (пример: `01.07.2026 | 30`)",
      ephemeral: true,
    });
    return;
  }

  const { issuedDate, days, endDate } = parsed;
  const amnesty = amnestyRaw === "да" || amnestyRaw === "yes";

  const existing = await db
    .select({ id: blacklistTable.id })
    .from(blacklistTable)
    .where(and(
      eq(blacklistTable.nickname, nickname),
      eq(blacklistTable.guildId, guildId),
      eq(blacklistTable.active, true),
    ))
    .limit(1);

  if (existing.length > 0) {
    await interaction.reply({
      content: `⚠️ Игрок **${nickname}** уже в активном чёрном списке.`,
      ephemeral: true,
    });
    return;
  }

  await db.insert(blacklistTable).values({
    nickname,
    reason,
    days,
    amnesty,
    issuedBy,
    guildId,
    expiresAt: null,
    active: true,
  });

  const durationValue = days === 0
    ? "Навсегда ♾️"
    : `${formatDate(issuedDate)} → ${endDate ? formatDate(endDate) : "?"} (${days} дн.)`;

  const embed = new EmbedBuilder()
    .setTitle("🛑 : чёрный список семьи 🛑")
    .setColor(Colors.DarkRed)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "Причина чёрного списка", value: reason },
      { name: "Срок ЧС", value: durationValue },
      {
        name: "Дата снятия ЧС",
        value: endDate ? formatDate(endDate) : "Бессрочно ♾️",
        inline: true,
      },
      { name: "Возможна ли амнистия", value: amnesty ? "Да ✅" : "Нет ❌", inline: true },
      { name: "Кто выдал ЧС", value: issuedBy, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  await interaction.reply({ embeds: [embed] });
}

// ─── /bl ──────────────────────────────────────────────────────────────────────

async function handleBlCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const nickname = interaction.options.getString("nickname", true).trim();
  const guildId  = interaction.guildId ?? "global";

  const rows = await db
    .select()
    .from(blacklistTable)
    .where(and(
      eq(blacklistTable.nickname, nickname),
      eq(blacklistTable.guildId, guildId),
      eq(blacklistTable.active, true),
    ))
    .limit(1);

  if (rows.length === 0) {
    await interaction.reply({
      content: `✅ Игрок **${nickname}** не находится в активном чёрном списке.`,
      ephemeral: true,
    });
    return;
  }

  const bl = rows[0]!;
  const endDate = bl.days > 0
    ? (() => { const d = new Date(bl.issuedAt); d.setDate(d.getDate() + bl.days); return d; })()
    : null;

  const durationValue = bl.days === 0
    ? "Бессрочно ♾️"
    : `${formatDate(bl.issuedAt)} — ${endDate ? formatDate(endDate) : "?"}`;

  const embed = new EmbedBuilder()
    .setTitle(`🛑 чёрный список семьи игрока: ${nickname} 🛑`)
    .setColor(Colors.DarkRed)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "За что выдан ЧС", value: bl.reason },
      { name: "От скольки до скольки длится ЧС", value: durationValue },
      { name: "Есть ли возможность амнистии", value: bl.amnesty ? "Да ✅" : "Нет ❌", inline: true },
      { name: "Кто выдавал", value: bl.issuedBy, inline: true },
      { name: "Прогресс до снятия", value: calcPercent(bl.issuedAt, bl.days) },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── /unblacklist ─────────────────────────────────────────────────────────────

async function handleUnblacklistCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const nickname = interaction.options.getString("nickname", true).trim();
  const guildId  = interaction.guildId ?? "global";

  const active = await db
    .select({ id: blacklistTable.id })
    .from(blacklistTable)
    .where(and(
      eq(blacklistTable.nickname, nickname),
      eq(blacklistTable.guildId, guildId),
      eq(blacklistTable.active, true),
    ))
    .limit(1);

  if (active.length === 0) {
    await interaction.reply({
      content: `ℹ️ У игрока **${nickname}** нет активного чёрного списка.`,
      ephemeral: true,
    });
    return;
  }

  await db
    .update(blacklistTable)
    .set({ active: false })
    .where(and(
      eq(blacklistTable.nickname, nickname),
      eq(blacklistTable.guildId, guildId),
      eq(blacklistTable.active, true),
    ));

  const embed = new EmbedBuilder()
    .setTitle("✅ чёрный список семьи снят ✅")
    .setColor(Colors.Green)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "Кто снял ЧС", value: interaction.user.username, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  await interaction.reply({ embeds: [embed] });
}

// ─── /warn ────────────────────────────────────────────────────────────────────

async function handleWarnCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("warn_modal")
    .setTitle("⚠️ Предупреждение семьи ⚠️");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("nickname")
        .setLabel("Никнейм игрока")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Введите никнейм"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Причина предупреждения")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder("Укажите причину"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("issued_by")
        .setLabel("От кого было выдано")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Введите никнейм выдавшего"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleWarnModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const nickname = interaction.fields.getTextInputValue("nickname").trim();
  const reason   = interaction.fields.getTextInputValue("reason").trim();
  const issuedBy = interaction.fields.getTextInputValue("issued_by").trim();
  const guildId  = interaction.guildId ?? "global";
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  let count = 0;
  let autoBlacklisted = false;

  await db.transaction(async (tx) => {
    await tx.insert(warningsTable).values({
      nickname, reason, issuedBy, guildId, expiresAt, active: true,
    });

    const rows = await tx
      .select({ id: warningsTable.id })
      .from(warningsTable)
      .where(and(
        eq(warningsTable.nickname, nickname),
        eq(warningsTable.guildId, guildId),
        eq(warningsTable.active, true),
      ));

    count = rows.length;

    if (count >= 3) {
      const existingBL = await tx
        .select({ id: blacklistTable.id })
        .from(blacklistTable)
        .where(and(
          eq(blacklistTable.nickname, nickname),
          eq(blacklistTable.guildId, guildId),
          eq(blacklistTable.active, true),
        ))
        .limit(1);

      if (existingBL.length === 0) {
        await tx.insert(blacklistTable).values({
          nickname,
          reason: "Автоматический ЧС: набрал 3/3 предупреждений",
          days: 0,
          amnesty: false,
          issuedBy: "🤖 Система",
          guildId,
          expiresAt: null,
          active: true,
        });
        autoBlacklisted = true;
      }

      await tx
        .update(warningsTable)
        .set({ active: false })
        .where(and(
          eq(warningsTable.nickname, nickname),
          eq(warningsTable.guildId, guildId),
          eq(warningsTable.active, true),
        ));
    }
  });

  const displayCount = Math.min(count, 3);
  const filled = "🟡".repeat(displayCount);
  const empty  = "⚪".repeat(3 - displayCount);

  const embed = new EmbedBuilder()
    .setTitle("⚠️ предупреждение семьи ⚠️")
    .setColor(autoBlacklisted ? Colors.DarkRed : Colors.Yellow)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "Причина", value: reason },
      {
        name: "Предупреждений",
        value: `${displayCount}/3 ${filled}${empty}`,
        inline: true,
      },
      { name: "От кого было выдано", value: issuedBy, inline: true },
      {
        name: "ℹ️ Информация",
        value: "Предупреждение снимается автоматически через 7 дней",
      },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  if (autoBlacklisted) {
    embed.addFields({
      name: "⛔ АВТОМАТИЧЕСКИЙ ЧС ВЫДАН",
      value: "Игрок набрал **3/3** предупреждений и автоматически внесён в чёрный список!",
    });
  }

  await interaction.reply({ embeds: [embed] });
}

// ─── /unwarn ──────────────────────────────────────────────────────────────────

async function handleUnwarnCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const nickname = interaction.options.getString("nickname", true).trim();
  const guildId  = interaction.guildId ?? "global";

  const recent = await db
    .select()
    .from(warningsTable)
    .where(and(
      eq(warningsTable.nickname, nickname),
      eq(warningsTable.guildId, guildId),
      eq(warningsTable.active, true),
    ))
    .orderBy(desc(warningsTable.issuedAt))
    .limit(1);

  if (recent.length === 0) {
    await interaction.reply({
      content: `ℹ️ У игрока **${nickname}** нет активных предупреждений.`,
      ephemeral: true,
    });
    return;
  }

  const warning = recent[0]!;
  await db.update(warningsTable).set({ active: false }).where(eq(warningsTable.id, warning.id));

  const remaining = await db
    .select({ id: warningsTable.id })
    .from(warningsTable)
    .where(and(
      eq(warningsTable.nickname, nickname),
      eq(warningsTable.guildId, guildId),
      eq(warningsTable.active, true),
    ));

  const left   = remaining.length;
  const filled = "🟡".repeat(left);
  const empty  = "⚪".repeat(Math.max(0, 3 - left));

  const embed = new EmbedBuilder()
    .setTitle("🟢 Предупреждение снято")
    .setColor(Colors.Green)
    .addFields(
      { name: "Игрок", value: nickname, inline: true },
      { name: "Осталось предупреждений", value: `${left}/3 ${filled}${empty}`, inline: true },
      { name: "Снятое предупреждение", value: warning.reason },
    )
    .setTimestamp()
    .setFooter({ text: `Снял: ${interaction.user.username}` });

  await interaction.reply({ embeds: [embed] });
}

// ─── /history ─────────────────────────────────────────────────────────────────

async function handleHistoryCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const nickname = interaction.options.getString("nickname", true).trim();
  const guildId  = interaction.guildId ?? "global";

  const [blacklistHistory, warningHistory] = await Promise.all([
    db.select().from(blacklistTable)
      .where(and(eq(blacklistTable.nickname, nickname), eq(blacklistTable.guildId, guildId)))
      .orderBy(desc(blacklistTable.issuedAt)).limit(5),
    db.select().from(warningsTable)
      .where(and(eq(warningsTable.nickname, nickname), eq(warningsTable.guildId, guildId)))
      .orderBy(desc(warningsTable.issuedAt)).limit(5),
  ]);

  if (blacklistHistory.length === 0 && warningHistory.length === 0) {
    await interaction.reply({
      content: `📜 У игрока **${nickname}** нет истории наказаний. Чист! ✅`,
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📜 история чёрного списка семьи игрока: ${nickname} 📜`)
    .setColor(Colors.Blue)
    .addFields({ name: "Никнейм", value: nickname, inline: true })
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  if (blacklistHistory.length > 0) {
    const lines = blacklistHistory.map((bl, i) => {
      const date   = formatDate(bl.issuedAt);
      const status = bl.active ? "🔴 Активен" : "⚫ Снят";
      const dur    = bl.days === 0 ? "Навсегда ♾️" : `${bl.days} дн.`;
      return (
        `**${i + 1}.** ${status} · ${date} · ${dur} · Амнистия: ${bl.amnesty ? "Да" : "Нет"}\n` +
        `> Причина: ${bl.reason}\n` +
        `> От: ${bl.issuedBy}`
      );
    });
    embed.addFields({ name: `⛔ Чёрный список — ${blacklistHistory.length} запись(-ей)`, value: lines.join("\n\n") });
  }

  if (warningHistory.length > 0) {
    const lines = warningHistory.map((w, i) => {
      const date   = formatDate(w.issuedAt);
      const status = w.active ? "🟡 Активно" : "✅ Снято";
      return (
        `**${i + 1}.** ${status} · ${date}\n` +
        `> Причина: ${w.reason}\n` +
        `> От: ${w.issuedBy}`
      );
    });
    embed.addFields({ name: `⚠️ Предупреждения — ${warningHistory.length} запись(-ей)`, value: lines.join("\n\n") });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── /staff ───────────────────────────────────────────────────────────────────

async function handleStaffCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("staff_modal")
    .setTitle("📌 Состав семьи");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("leader")
        .setLabel("Никнейм лидера [10]")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Никнейм лидера"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("deputies")
        .setLabel("Никнейм заместителей [9]")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder("Каждый никнейм с новой строки"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("senior")
        .setLabel("Никнейм старшего состава [8]")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder("Каждый никнейм с новой строки"),
    ),
  );

  await interaction.showModal(modal);
}

async function handleStaffModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!hasModPermission(interaction.member as GuildMember | null)) {
    await denyAccess(interaction);
    return;
  }

  const leader   = interaction.fields.getTextInputValue("leader").trim();
  const deputies = interaction.fields.getTextInputValue("deputies").trim();
  const senior   = interaction.fields.getTextInputValue("senior").trim();
  const today    = formatDate(new Date());

  const formatList = (raw: string): string => {
    if (!raw) return "—";
    return raw.split("\n")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => `• ${n}`)
      .join("\n");
  };

  const embed = new EmbedBuilder()
    .setTitle(`📌 актуальный список старшего состава/лидера семьи за ${today} 📌`)
    .setColor(Colors.Gold)
    .addFields(
      { name: "👑 Лидер [10]", value: leader },
      { name: "🥈 Заместители [9]", value: formatList(deputies) },
      { name: "⭐ Старший состав [8]", value: formatList(senior) },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный состав • обновляется ежедневно" });

  await interaction.reply({ embeds: [embed] });
}

// ─── Auto-expiry (every 10 min) ───────────────────────────────────────────────

async function checkExpiry(): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(warningsTable)
      .set({ active: false })
      .where(and(eq(warningsTable.active, true), lt(warningsTable.expiresAt, now)));
  } catch (err) {
    logger.error({ err }, "Error during expiry check");
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  if (!TOKEN || !CLIENT_ID) {
    logger.warn("DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID not set — bot not started");
    return;
  }

  client.once("clientReady", async () => {
    logger.info({ tag: client.user?.tag }, "Discord bot ready");
    try {
      await registerCommands(CLIENT_ID, TOKEN);
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }
    setInterval(() => void checkExpiry(), 10 * 60 * 1000);
    await checkExpiry();
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case "blacklist":   await handleBlacklistCommand(interaction);   break;
          case "bl":          await handleBlCommand(interaction);          break;
          case "unblacklist": await handleUnblacklistCommand(interaction); break;
          case "warn":        await handleWarnCommand(interaction);        break;
          case "unwarn":      await handleUnwarnCommand(interaction);      break;
          case "history":     await handleHistoryCommand(interaction);     break;
          case "staff":       await handleStaffCommand(interaction);       break;
        }
      } else if (interaction.isModalSubmit()) {
        switch (interaction.customId) {
          case "blacklist_modal": await handleBlacklistModal(interaction); break;
          case "warn_modal":      await handleWarnModal(interaction);      break;
          case "staff_modal":     await handleStaffModal(interaction);     break;
        }
      }
    } catch (err) {
      logger.error({ err }, "Discord interaction error");
      try {
        const msg = { content: "❌ Произошла ошибка. Попробуйте снова.", ephemeral: true };
        if (interaction.isRepliable()) {
          const i = interaction as typeof interaction & { replied?: boolean; deferred?: boolean };
          if (i.replied || i.deferred) {
            await (interaction as any).followUp(msg);
          } else {
            await (interaction as any).reply(msg);
          }
        }
      } catch { /* ignore */ }
    }
  });

  await client.login(TOKEN);
}
