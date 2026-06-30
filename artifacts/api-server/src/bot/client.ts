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
  PermissionFlagsBits,
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

function hasModPermission(member: GuildMember | null): boolean {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

async function denyAccess(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
): Promise<void> {
  await interaction.reply({
    content:
      "⛔ У вас нет прав для использования этой команды.\nТребуется право **Управление сервером** или **Администратор**.",
    ephemeral: true,
  });
}

// ─── Command registration ─────────────────────────────────────────────────────

async function registerCommands(clientId: string, token: string): Promise<void> {
  const rest = new REST().setToken(token);

  const modPerm = String(PermissionFlagsBits.ManageGuild);

  const commands = [
    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("⛔ Выдать чёрный список игроку")
      .setDefaultMemberPermissions(modPerm),

    new SlashCommandBuilder()
      .setName("unblacklist")
      .setDescription("✅ Снять чёрный список с игрока")
      .setDefaultMemberPermissions(modPerm)
      .addStringOption((opt) =>
        opt
          .setName("nickname")
          .setDescription("Никнейм игрока")
          .setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("⚠️ Выдать предупреждение игроку (действует 7 дней)")
      .setDefaultMemberPermissions(modPerm),

    new SlashCommandBuilder()
      .setName("unwarn")
      .setDescription("🟢 Снять предупреждение с игрока")
      .setDefaultMemberPermissions(modPerm)
      .addStringOption((opt) =>
        opt
          .setName("nickname")
          .setDescription("Никнейм игрока")
          .setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("history")
      .setDescription("📋 История наказаний игрока")
      .setDefaultMemberPermissions(modPerm)
      .addStringOption((opt) =>
        opt
          .setName("nickname")
          .setDescription("Никнейм игрока")
          .setRequired(true),
      ),
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

  const modal = new ModalBuilder()
    .setCustomId("blacklist_modal")
    .setTitle("⛔ Выдача чёрного списка");

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
        .setLabel("Причина ЧС")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder("Укажите причину"),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("days")
        .setLabel("На сколько дней (0 = навсегда)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Например: 30"),
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
        .setLabel("От кого выдана ЧС")
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

  const nickname = interaction.fields.getTextInputValue("nickname").trim();
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const daysStr = interaction.fields.getTextInputValue("days").trim();
  const amnestyRaw = interaction.fields
    .getTextInputValue("amnesty")
    .trim()
    .toLowerCase();
  const issuedBy = interaction.fields.getTextInputValue("issued_by").trim();
  const guildId = interaction.guildId ?? "global";

  const days = parseInt(daysStr, 10);
  if (isNaN(days) || days < 0) {
    await interaction.reply({
      content: "❌ Укажите корректное количество дней (число ≥ 0).",
      ephemeral: true,
    });
    return;
  }

  const amnesty = amnestyRaw === "да" || amnestyRaw === "yes";

  // Check for already-active blacklist
  const existing = await db
    .select({ id: blacklistTable.id })
    .from(blacklistTable)
    .where(
      and(
        eq(blacklistTable.nickname, nickname),
        eq(blacklistTable.guildId, guildId),
        eq(blacklistTable.active, true),
      ),
    )
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
    expiresAt: null, // ЧС никогда не снимается автоматически
    active: true,
  });

  const embed = new EmbedBuilder()
    .setTitle("⛔️ Чёрный список семьи ⛔️")
    .setColor(Colors.Red)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "Причина ЧС", value: reason },
      {
        name: "На сколько дней",
        value: days === 0 ? "Навсегда ♾️" : `${days} дней`,
        inline: true,
      },
      {
        name: "Возможна амнистия",
        value: amnesty ? "Да ✅" : "Нет ❌",
        inline: true,
      },
      { name: "От кого выдана ЧС", value: issuedBy, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  await interaction.reply({ embeds: [embed] });
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
  const guildId = interaction.guildId ?? "global";

  const active = await db
    .select({ id: blacklistTable.id })
    .from(blacklistTable)
    .where(
      and(
        eq(blacklistTable.nickname, nickname),
        eq(blacklistTable.guildId, guildId),
        eq(blacklistTable.active, true),
      ),
    )
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
    .where(
      and(
        eq(blacklistTable.nickname, nickname),
        eq(blacklistTable.guildId, guildId),
        eq(blacklistTable.active, true),
      ),
    );

  const embed = new EmbedBuilder()
    .setTitle("✅ Чёрный список снят")
    .setColor(Colors.Green)
    .addFields({ name: "Игрок", value: nickname, inline: true })
    .setTimestamp()
    .setFooter({ text: `Снял: ${interaction.user.username}` });

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
    .setTitle("⚠️ Выдача предупреждения");

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
        .setLabel("От кого выдано")
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
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const issuedBy = interaction.fields.getTextInputValue("issued_by").trim();
  const guildId = interaction.guildId ?? "global";
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  let count = 0;
  let autoBlacklisted = false;

  await db.transaction(async (tx) => {
    await tx.insert(warningsTable).values({
      nickname,
      reason,
      issuedBy,
      guildId,
      expiresAt,
      active: true,
    });

    const rows = await tx
      .select({ id: warningsTable.id })
      .from(warningsTable)
      .where(
        and(
          eq(warningsTable.nickname, nickname),
          eq(warningsTable.guildId, guildId),
          eq(warningsTable.active, true),
        ),
      );

    count = rows.length;

    if (count >= 3) {
      const existingBL = await tx
        .select({ id: blacklistTable.id })
        .from(blacklistTable)
        .where(
          and(
            eq(blacklistTable.nickname, nickname),
            eq(blacklistTable.guildId, guildId),
            eq(blacklistTable.active, true),
          ),
        )
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
        .where(
          and(
            eq(warningsTable.nickname, nickname),
            eq(warningsTable.guildId, guildId),
            eq(warningsTable.active, true),
          ),
        );
    }
  });

  const displayCount = Math.min(count, 3);
  const filled = "🟡".repeat(displayCount);
  const empty = "⚪".repeat(3 - displayCount);

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Предупреждение в семье ⚠️")
    .setColor(autoBlacklisted ? Colors.DarkRed : Colors.Yellow)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "Причина", value: reason },
      {
        name: "Предупреждений",
        value: `${displayCount}/3 ${filled}${empty}`,
        inline: true,
      },
      { name: "От кого выдано", value: issuedBy, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Предупреждение снимается автоматически через 7 дней" });

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
  const guildId = interaction.guildId ?? "global";

  // Find the most recent active warning
  const recent = await db
    .select()
    .from(warningsTable)
    .where(
      and(
        eq(warningsTable.nickname, nickname),
        eq(warningsTable.guildId, guildId),
        eq(warningsTable.active, true),
      ),
    )
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

  await db
    .update(warningsTable)
    .set({ active: false })
    .where(eq(warningsTable.id, warning.id));

  // Count remaining active warnings
  const remaining = await db
    .select({ id: warningsTable.id })
    .from(warningsTable)
    .where(
      and(
        eq(warningsTable.nickname, nickname),
        eq(warningsTable.guildId, guildId),
        eq(warningsTable.active, true),
      ),
    );

  const left = remaining.length;
  const filled = "🟡".repeat(left);
  const empty = "⚪".repeat(Math.max(0, 3 - left));

  const embed = new EmbedBuilder()
    .setTitle("🟢 Предупреждение снято")
    .setColor(Colors.Green)
    .addFields(
      { name: "Игрок", value: nickname, inline: true },
      {
        name: "Осталось предупреждений",
        value: `${left}/3 ${filled}${empty}`,
        inline: true,
      },
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
  const guildId = interaction.guildId ?? "global";

  const [blacklistHistory, warningHistory] = await Promise.all([
    db
      .select()
      .from(blacklistTable)
      .where(
        and(
          eq(blacklistTable.nickname, nickname),
          eq(blacklistTable.guildId, guildId),
        ),
      )
      .orderBy(desc(blacklistTable.issuedAt))
      .limit(5),
    db
      .select()
      .from(warningsTable)
      .where(
        and(
          eq(warningsTable.nickname, nickname),
          eq(warningsTable.guildId, guildId),
        ),
      )
      .orderBy(desc(warningsTable.issuedAt))
      .limit(5),
  ]);

  if (blacklistHistory.length === 0 && warningHistory.length === 0) {
    await interaction.reply({
      content: `📋 У игрока **${nickname}** нет истории наказаний. Чист! ✅`,
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 История наказаний: ${nickname}`)
    .setColor(Colors.Blue)
    .setTimestamp();

  if (blacklistHistory.length > 0) {
    const lines = blacklistHistory.map((bl, i) => {
      const date = bl.issuedAt.toLocaleDateString("ru-RU");
      const status = bl.active ? "🔴 Активен" : "⚫ Снят";
      const duration = bl.days === 0 ? "Навсегда" : `${bl.days} дн.`;
      const amnestyLabel = bl.amnesty ? "Да" : "Нет";
      return (
        `**${i + 1}.** ${status} · ${date} · ${duration} · Амнистия: ${amnestyLabel}\n` +
        `> Причина: ${bl.reason}\n` +
        `> От: ${bl.issuedBy}`
      );
    });
    embed.addFields({
      name: `⛔ ЧС — всего ${blacklistHistory.length}`,
      value: lines.join("\n\n"),
    });
  }

  if (warningHistory.length > 0) {
    const lines = warningHistory.map((w, i) => {
      const date = w.issuedAt.toLocaleDateString("ru-RU");
      const status = w.active ? "🟡 Активно" : "✅ Снято";
      return (
        `**${i + 1}.** ${status} · ${date}\n` +
        `> Причина: ${w.reason}\n` +
        `> От: ${w.issuedBy}`
      );
    });
    embed.addFields({
      name: `⚠️ Предупреждения — всего ${warningHistory.length}`,
      value: lines.join("\n\n"),
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Auto-expiry (every 10 min) ───────────────────────────────────────────────

async function checkExpiry(): Promise<void> {
  const now = new Date();
  try {
    // Только предупреждения снимаются автоматически через 7 дней.
    // ЧС никогда не снимается автоматически.
    await db
      .update(warningsTable)
      .set({ active: false })
      .where(
        and(eq(warningsTable.active, true), lt(warningsTable.expiresAt, now)),
      );
  } catch (err) {
    logger.error({ err }, "Error during expiry check");
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  if (!TOKEN || !CLIENT_ID) {
    logger.warn(
      "DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID not set — bot not started",
    );
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
          case "blacklist":   await handleBlacklistCommand(interaction); break;
          case "unblacklist": await handleUnblacklistCommand(interaction); break;
          case "warn":        await handleWarnCommand(interaction); break;
          case "unwarn":      await handleUnwarnCommand(interaction); break;
          case "history":     await handleHistoryCommand(interaction); break;
        }
      } else if (interaction.isModalSubmit()) {
        switch (interaction.customId) {
          case "blacklist_modal": await handleBlacklistModal(interaction); break;
          case "warn_modal":      await handleWarnModal(interaction); break;
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
