import { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import fetch from "node-fetch";

// === 1️⃣ Client Setup ===
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// === 2️⃣ Flight Data (static example) ===
const flights = {
  "SIA216": {
    aircraft: "Airbus A350-941",
    registration: "9V-SHI",
    depICAO: "YPPH",
    depIATA: "PER",
    depAirport: "Perth",
    depLocal: "01:15",
    depUTC: "05:15",
    arrICAO: "WSSS",
    arrIATA: "SIN",
    arrAirport: "Singapore Changi Airport",
    arrLocal: "06:30",
    arrUTC: "10:30",
    duration: "5h 15min"
  }
};

// === 3️⃣ RPC / Presence ===
client.once("ready", () => {
  console.log(`FS Operations online as ${client.user.tag}`);
  client.user.setActivity("Microsoft Flight Simulator", { type: ActivityType.Watching });
});

// === 4️⃣ Slash Commands ===
const commands = [
  new SlashCommandBuilder()
    .setName("flightsearch")
    .setDescription("Search for a flight")
    .addStringOption(option =>
      option.setName("flight_number")
        .setDescription("Flight number (e.g. SIA216)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("metar")
    .setDescription("Get METAR for an airport")
    .addStringOption(option =>
      option.setName("icao")
        .setDescription("ICAO code (e.g. WSSS)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("taf")
    .setDescription("Get TAF for an airport")
    .addStringOption(option =>
      option.setName("icao")
        .setDescription("ICAO code (e.g. WSSS)")
        .setRequired(true)
    )
].map(c => c.toJSON());

// === 5️⃣ Register Commands ===
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("Commands registered!");
  } catch (err) { console.error(err); }
})();

// === 6️⃣ Handle Commands ===
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // -------- Flight Search --------
  if (interaction.commandName === "flightsearch") {
    const flightNo = interaction.options.getString("flight_number").toUpperCase();
    const flight = flights[flightNo];

    if (!flight) return interaction.reply({ content: `❌ Flight **${flightNo}** not found`, ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor(0x1E90FF)
      .setTitle(`✈️ Flight: **${flightNo}**`)
      .addFields(
        { name: "Aircraft", value: `**${flight.aircraft} [${flight.registration}]**`, inline: false },
        { name: "Departure Airport", value: `**${flight.depICAO} / ${flight.depIATA} – ${flight.depAirport}**`, inline: false },
        { name: "Arrival Airport", value: `**${flight.arrICAO} / ${flight.arrIATA} – ${flight.arrAirport}**`, inline: false },
        { name: "Scheduled Departure Time", value: `• **${flight.depLocal} Local Time**\n• **${flight.depUTC} UTC**`, inline: false },
        { name: "Scheduled Arrival Time", value: `• **${flight.arrLocal} Local Time**\n• **${flight.arrUTC} UTC**`, inline: false },
        { name: "Scheduled Duration", value: `**${flight.duration}**`, inline: false }
      )
      .setFooter({ text: "FS Operations" });

    return interaction.reply({ embeds: [embed] });
  }

  // -------- METAR --------
  if (interaction.commandName === "metar") {
    const icao = interaction.options.getString("icao").toUpperCase();
    const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw`);
    const text = await res.text();
    return interaction.reply(`**METAR ${icao}**\n\`\`\`${text || "No data"}\`\`\``);
  }

  // -------- TAF --------
  if (interaction.commandName === "taf") {
    const icao = interaction.options.getString("icao").toUpperCase();
    const res = await fetch(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=raw`);
    const text = await res.text();
    return interaction.reply(`**TAF ${icao}**\n\`\`\`${text || "No data"}\`\`\``);
  }
});

// === 7️⃣ Login ===
client.login(process.env.DISCORD_TOKEN);
