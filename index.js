// index.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  Partials,
} from "discord.js";
import fetch from "node-fetch";
import express from "express";

// ===================== UPTIMEROBOT KEEP-ALIVE =====================
const app = express();
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send("FS Operations Bot is alive!");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`UptimeRobot server running on port ${PORT}`);
});

// ===================== 1️⃣ Client Setup =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ===================== 2️⃣ Presence =====================
client.once("ready", () => {
  console.log(`FS Operations online as ${client.user.tag}`);
  client.user.setPresence({
    status: 'dnd',
    activities: [{
      name: 'SimBrief Dispatch',
      type: 'PLAYING'
    }]
  });
});

// ===================== 3️⃣ Helper Functions =====================
const airlineMap = { SIA: "SQ", TGW: "TR", MAS: "MH", HVN: "VN", AXM: "AK" };

function mapFlightNumber(flightNo) {
  const prefix = flightNo.slice(0, 3);
  return airlineMap[prefix] ? airlineMap[prefix] + flightNo.slice(3) : flightNo;
}

function formatUTC(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return `${d.getUTCDate().toString().padStart(2, "0")}-${(d.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${d.getUTCFullYear()} ${d
    .getUTCHours()
    .toString()
    .padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
}

function getStatus(flight) {
  const depSch = flight.departure.scheduled;
  const depEst = flight.departure.estimated;
  const depAct = flight.departure.actual;
  const arrAct = flight.arrival.actual;

  if (arrAct) return "Aircraft Landed";
  if (!depAct) return "Flight Scheduled";
  if (depEst && depSch) {
    const diff = new Date(depEst) - new Date(depSch);
    if (diff > 5 * 60000) return "Flight Delayed";
    if (diff < -5 * 60000) return "Flight Early";
    return "Flight On-Time ✅";
  }
  return "Flight Scheduled";
}

function parseUTC(str) {
  if (!str) return null;
  const parts = str.split(" ");
  if (parts.length !== 2) return null;
  const [datePart, timePart] = parts;
  const dateParts = datePart.split("-").map(Number);
  const timeParts = timePart.split(":").map(Number);
  if (dateParts.length !== 3 || timeParts.length !== 2) return null;
  const [year, month, day] = dateParts;
  const [hour, minute] = timeParts;
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

function formatAirlineDate(d) {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = d.getUTCDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  const weekday = weekdays[d.getUTCDay()];
  const hour = d.getUTCHours().toString().padStart(2, "0");
  const minute = d.getUTCMinutes().toString().padStart(2, "0");
  return `${day} ${month} (${weekday}) ${hour}:${minute}`;
}

// ===================== 4️⃣ Runway / ATIS Logic =====================
const airportRunways = {
  WSSS: [
    { name: "02L/20R", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "02C/20C", enabled: false, preferredDeparture: false, preferredArrival: false },
    { name: "02R/20L", enabled: true, preferredDeparture: false, preferredArrival: true },
  ],
  // Add more airports as needed
};

function runwayHeading(rwyName) {
  const num = parseInt(rwyName.slice(0, 2), 10);
  return num * 10;
}

function isRunwayAligned(heading, windDeg) {
  const diff = Math.abs((heading - windDeg + 360) % 360);
  return diff <= 90;
}

function pickRunwayEnd(rwy, windDeg, forDeparture = true) {
  const ends = rwy.name.split("/"); // ["02L", "20R"]
  const headings = ends.map(runwayHeading);
  const targetDeg = forDeparture ? windDeg : (windDeg + 180) % 360;

  let bestIndex = 0;
  let minDiff = Math.abs((headings[0] - targetDeg + 360) % 360);

  for (let i = 1; i < headings.length; i++) {
    const diff = Math.abs((headings[i] - targetDeg + 360) % 360);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }

  return `Rwy ${ends[bestIndex]}`;
}

function pickRunways(icao, windDeg) {
  const dbRunways = airportRunways[icao] || [];

  // Get all enabled runways aligned with wind
  const alignedRunways = dbRunways.filter(rwy => {
    const headings = rwy.name.split("/").map(runwayHeading);
    return rwy.enabled && headings.some(hdg => isRunwayAligned(hdg, windDeg));
  });

  // Departure
  let departureRunway = alignedRunways.find(r => r.preferredDeparture);
  departureRunway = departureRunway
    ? pickRunwayEnd(departureRunway, windDeg, true)
    : alignedRunways.length > 0
    ? pickRunwayEnd(alignedRunways[0], windDeg, true)
    : "No runway data";

  // Arrival
  let arrivalRunway = alignedRunways.find(r => r.preferredArrival);
  arrivalRunway = arrivalRunway
    ? pickRunwayEnd(arrivalRunway, windDeg, false)
    : alignedRunways.length > 0
    ? pickRunwayEnd(alignedRunways[0], windDeg, false)
    : "No runway data";

  return { departureRunway, arrivalRunway };
}

// ===================== 5️⃣ Slash Commands =====================
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Ping the bot"),
  new SlashCommandBuilder()
    .setName("flight-search")
    .setDescription("Search for flight information via AviationStack")
    .addStringOption(option =>
      option.setName("flight-number")
        .setDescription("Enter the flight number (eg. SQ108, SIA826)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("metar")
    .setDescription("Get METAR for an airport (raw/formatted)")
    .addStringOption(option =>
      option.setName("icao")
        .setDescription("Enter the ICAO code (e.g. WSSS)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("format")
        .setDescription("Choose METAR format: Raw or Formatted")
        .setRequired(false)
        .addChoices(
          { name: "Formatted", value: "formatted" },
          { name: "Raw", value: "raw" },
        )
    ),
  new SlashCommandBuilder()
    .setName("taf")
    .setDescription("Get TAF for an airport (raw/formatted)")
    .addStringOption(option =>
      option.setName("icao")
        .setDescription("Enter the ICAO (e.g. WSSS)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("format")
        .setDescription("Choose TAF Format: Raw or Formatted")
        .setRequired(false)
        .addChoices(
          { name: "Formatted", value: "formatted" },
          { name: "Raw", value: "raw" },
        )
    ),
  new SlashCommandBuilder()
    .setName("atis-text")
    .setDescription("Get full METAR and runway recommendations")
    .addStringOption(option =>
      option.setName("icao")
        .setDescription("Enter the ICAO code (e.g. WSSS)")
        .setRequired(true)
    ),
].map(c => c.toJSON());

// ===================== 6️⃣ Register Commands =====================
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("Commands successfully registered!");
  } catch (err) {
    console.error(err);
  }
})();

// ===================== 7️⃣ Command Handling =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ------------------ Ping ------------------
  if (interaction.commandName === "ping") {
    const sent = await interaction.reply({ content: "Pinging...", fetchReply: true });
    const botLatency = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = interaction.client.ws.ping;
    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setDescription(`${interaction.user} Pong!\n\nBot latency Ping: ${botLatency}ms\nWebSocket Ping: ${wsPing}ms`)
      .setTimestamp();
    await interaction.editReply({ content: "", embeds: [embed] });
  }

  // ------------------ ATIS Text ------------------
  if (interaction.commandName === "atis-text") {
    const icao = interaction.options.getString("icao").toUpperCase();
    try {
      const res = await fetch(`https://api.checkwx.com/metar/${icao}/decoded`, { headers: { "X-API-Key": process.env.CHECKWX_KEY } });
      const data = await res.json();
      if (!data.results || data.results === 0) {
        await interaction.reply({ content: `No METAR found for ${icao}.`, ephemeral: true });
        return;
      }

      const metar = data.data[0];
      const rawText = metar.raw_text || "N/A";
      const windDeg = metar.wind?.degrees || 0;
      const windSpeed = metar.wind?.speed_kts || 0;
      const temp = metar.temperature?.celsius ?? "N/A";
      const dew = metar.dewpoint?.celsius ?? "N/A";
      const vis = metar.visibility?.miles_text ?? "N/A";
      const qnh = metar.barometer?.hpa ?? "N/A";
      const clouds = metar.clouds?.map(c => `${c.text} at ${c.feet}ft`).join(", ") || "N/A";

      const { departureRunway, arrivalRunway } = pickRunways(icao, windDeg);

      const embed = new EmbedBuilder()
        .setTitle(`ATIS/METAR — ${icao}`)
        .setColor(0x1e90ff)
        .addFields(
          { name: "Raw METAR", value: `\`\`\`${rawText}\`\`\`` },
          { name: "Wind", value: `${windDeg}° ${windSpeed}KT`, inline: true },
          { name: "Temperature", value: `${temp}°C`, inline: true },
          { name: "Dewpoint", value: `${dew}°C`, inline: true },
          { name: "Visibility", value: vis, inline: true },
          { name: "Pressure (QNH)", value: `${qnh} hPa`, inline: true },
          { name: "Clouds", value: clouds },
          { name: "Preferred Departure Runway", value: departureRunway, inline: true },
          { name: "Preferred Arrival Runway", value: arrivalRunway, inline: true }
        );

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching METAR for ${icao}.`, ephemeral: true });
    }
  }
});

// ===================== 8️⃣ Login =====================
client.login(process.env.DISCORD_TOKEN);
