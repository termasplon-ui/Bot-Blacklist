import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  Colors,
  type Interaction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { db } from "@workspace/db";
import { blacklistTable, warningsTable } from "@workspace/db";
import { eq, and, desc, lt } from "drizzle-orm";
import { logger } from "../lib/logger";

const TOKEN = process.env["DISCORD_BOT_TOKEN"];
const CLIENT_ID = process.env["DISCORD_CLIENT_ID"];

export const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(clientId: string, token: string) {
  const rest = new REST().setToken(token);
  const commands = [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Открыть панель управления семьёй")
      .toJSON(),
  ];
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Discord slash commands registered globally");
}

// ─── /panel handler ──────────────────────────────────────────────────────────

async function handlePanelCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("blacklist_btn")
      .setLabel("⛔ Выдать ЧС")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("warning_btn")
      .setLabel("⚠️ Предупреждение")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("history_btn")
      .setLabel("📋 История")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: "**🏠 Панель управления семьёй**\nВыберите действие:",
    components: [row],
  });
}

// ─── Modals ──────────────────────────────────────────────────────────────────

async function handleBlacklistButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("blacklist_modal")
    .setTitle("⛔ Выдача ЧС");

  const rows = [
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
  ];

  modal.addComponents(...rows);
  await interaction.showModal(modal);
}

async function handleWarningButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("warning_modal")
    .setTitle("⚠️ Выдача предупреждения");

  const rows = [
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
  ];

  modal.addComponents(...rows);
  await interaction.showModal(modal);
}

async function handleHistoryButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("history_modal")
    .setTitle("📋 История наказаний");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("nickname")
        .setLabel("Никнейм игрока")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Введите никнейм"),
    ),
  );

  await interaction.showModal(modal);
}

// ─── Modal submit handlers ────────────────────────────────────────────────────

async function handleBlacklistModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
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
  const expiresAt =
    days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

  await db.insert(blacklistTable).values({
    nickname,
    reason,
    days,
    amnesty,
    issuedBy,
    guildId,
    expiresAt,
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
      { name: "Возможна амнистия", value: amnesty ? "Да ✅" : "Нет ❌", inline: true },
      { name: "От кого выдана ЧС", value: issuedBy, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Семейный чёрный список" });

  await interaction.reply({ embeds: [embed] });
}

async function handleWarningModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const nickname = interaction.fields.getTextInputValue("nickname").trim();
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const issuedBy = interaction.fields.getTextInputValue("issued_by").trim();
  const guildId = interaction.guildId ?? "global";

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(warningsTable).values({
    nickname,
    reason,
    issuedBy,
    guildId,
    expiresAt,
    active: true,
  });

  // Count active warnings for this player in this guild
  const activeWarnings = await db
    .select()
    .from(warningsTable)
    .where(
      and(
        eq(warningsTable.nickname, nickname),
        eq(warningsTable.guildId, guildId),
        eq(warningsTable.active, true),
      ),
    );

  const count = activeWarnings.length;

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Предупреждение в семье ⚠️")
    .setColor(Colors.Yellow)
    .addFields(
      { name: "Никнейм", value: nickname, inline: true },
      { name: "Причина", value: reason },
      {
        name: "Предупреждений",
        value: `${count}/3 ${"🟡".repeat(count)}${"⚪".repeat(3 - count)}`,
        inline: true,
      },
      { name: "От кого выдано", value: issuedBy, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Предупреждение снимается автоматически через 7 дней" });

  // Auto-blacklist on 3rd warning
  if (count >= 3) {
    await db.insert(blacklistTable).values({
      nickname,
      reason: "Автоматический ЧС: набрал 3/3 предупреждений",
      days: 0,
      amnesty: false,
      issuedBy: "🤖 Система",
      guildId,
      expiresAt: null,
      active: true,
    });

    // Deactivate all warnings for this player
    await db
      .update(warningsTable)
      .set({ active: false })
      .where(
        and(
          eq(warningsTable.nickname, nickname),
          eq(warningsTable.guildId, guildId),
          eq(warningsTable.active, true),
        ),
      );

    embed
      .setColor(Colors.DarkRed)
      .addFields({
        name: "⛔ АВТОМАТИЧЕСКИЙ ЧС ВЫДАН",
        value:
          "Игрок набрал **3/3** предупреждений и автоматически внесён в чёрный список!",
      });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleHistoryModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const nickname = interaction.fields.getTextInputValue("nickname").trim();
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
      const status = bl.active ? "🔴 Активен" : "⚫ Истёк";
      const duration =
        bl.days === 0 ? "Навсегда" : `${bl.days} дн.`;
      const amnesty = bl.amnesty ? "Да" : "Нет";
      return (
        `**${i + 1}.** ${status} · ${date} · ${duration} · Амнистия: ${amnesty}\n` +
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

// ─── Auto-expiry ──────────────────────────────────────────────────────────────

async function checkExpiry(): Promise<void> {
  const now = new Date();
  try {
    // Expire warnings that passed their 7-day deadline
    await db
      .update(warningsTable)
      .set({ active: false })
      .where(
        and(eq(warningsTable.active, true), lt(warningsTable.expiresAt, now)),
      );

    // Expire timed blacklists — NULL expiresAt means permanent, PostgreSQL
    // evaluates NULL < now() as NULL (falsy) so permanent rows are untouched.
    await db
      .update(blacklistTable)
      .set({ active: false })
      .where(
        and(
          eq(blacklistTable.active, true),
          lt(blacklistTable.expiresAt, now),
        ),
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
      logger.error({ err }, "Failed to register Discord slash commands — check DISCORD_CLIENT_ID (must be the numeric Application ID, not the token)");
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
        if (interaction.commandName === "panel") {
          await handlePanelCommand(interaction);
        }
      } else if (interaction.isButton()) {
        if (interaction.customId === "blacklist_btn") {
          await handleBlacklistButton(interaction);
        } else if (interaction.customId === "warning_btn") {
          await handleWarningButton(interaction);
        } else if (interaction.customId === "history_btn") {
          await handleHistoryButton(interaction);
        }
      } else if (interaction.isModalSubmit()) {
        if (interaction.customId === "blacklist_modal") {
          await handleBlacklistModal(interaction);
        } else if (interaction.customId === "warning_modal") {
          await handleWarningModal(interaction);
        } else if (interaction.customId === "history_modal") {
          await handleHistoryModal(interaction);
        }
      }
    } catch (err) {
      logger.error({ err }, "Discord interaction error");
      try {
        const msg = { content: "❌ Произошла ошибка. Попробуйте снова.", ephemeral: true };
        if (interaction.isRepliable()) {
          const i = interaction as { replied?: boolean; deferred?: boolean } & typeof interaction;
          if (i.replied || i.deferred) {
            await (interaction as any).followUp(msg);
          } else {
            await (interaction as any).reply(msg);
          }
        }
      } catch {
        // ignore secondary error
      }
    }
  });

  await client.login(TOKEN);
}
