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

function isRunwayAligned(heading, windDeg) {
  const diff = Math.abs((heading - windDeg + 360) % 360);
  return diff <= 90;
}

function runwayHeading(rwyName) {
  const num = parseInt(rwyName.slice(0, 2), 10);
  return num * 10;
}

function pickRunways(icao, windDeg) {
  const dbRunways = airportRunways[icao] || [];
  const compatible = [];

  dbRunways.forEach((rwy) => {
    const rwyHeadings = rwy.name.split("/").map(runwayHeading);
    const matchesWind = rwyHeadings.some((hdg) => isRunwayAligned(hdg, windDeg));
    if (rwy.enabled && matchesWind) {
      compatible.push(rwy);
    }
  });

  // fallback: if no preferred, list all enabled runways
  if (compatible.length === 0) {
    dbRunways.forEach((rwy) => {
      if (rwy.enabled) compatible.push(rwy);
    });
  }

  return compatible;
}

// ===================== 5️⃣ Slash Commands =====================
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Ping the bot"),
  new SlashCommandBuilder()
    .setName("flight-search")
    .setDescription("Search for flight information via AviationStack")
    .addStringOption((option) =>
      option
        .setName("flight-number")
        .setDescription("Enter the flight number (eg. SQ108, SIA826)")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("metar")
    .setDescription("Get METAR for an airport (raw/formatted)")
    .addStringOption((option) =>
      option
        .setName("icao")
        .setDescription("Enter the ICAO code (e.g. WSSS)")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("format")
        .setDescription("Choose METAR format: Raw or Formatted")
        .setRequired(false)
        .addChoices(
          { name: "Formatted", value: "formatted" },
          { name: "Raw", value: "raw" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("taf")
    .setDescription("Get TAF for an airport (raw/formatted)")
    .addStringOption((option) =>
      option
        .setName("icao")
        .setDescription("Enter the ICAO (e.g. WSSS)")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("format")
        .setDescription("Choose TAF Format: Raw or Formatted")
        .setRequired(false)
        .addChoices(
          { name: "Formatted", value: "formatted" },
          { name: "Raw", value: "raw" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("flight-announce")
    .setDescription("Post a flight announcement.")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Select a channel to post the announcement.")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("status")
        .setDescription("Select flight status.")
        .setRequired(true)
        .addChoices(
          { name: "Booking", value: "booking" },
          { name: "Check-in Opened", value: "checkin" },
          { name: "Counter Check-in Opened", value: "counter_checkin" },
          { name: "Boarding", value: "boarding" },
          { name: "Gate Closed", value: "gate_closed" },
          { name: "Flight Cancelled", value: "cancelled" },
          { name: "Flight Delayed", value: "delayed" }
        ),
    )
    .addStringOption((o) => o.setName("airline").setDescription("Airline").setRequired(true))
    .addStringOption((o) => o.setName("flight-number").setDescription("Enter the flight number").setRequired(true))
    .addStringOption((o) => o.setName("departure-airport").setDescription("The departure airport").setRequired(true))
    .addStringOption((o) => o.setName("arrival-airport").setDescription("The arrival airport").setRequired(true))
    .addBooleanOption((o) => o.setName("non-stop").setDescription("Is the flight non-stop?").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("Duration of the flight (estimated block time)").setRequired(true))
    .addStringOption((o) => o.setName("departure-time").setDescription("Scheduled Departure Time (YYYY-MM-DD HH:MM)").setRequired(true))
    .addStringOption((o) => o.setName("arrival-time").setDescription("Scheduled Arrival time (YYYY-MM-DD HH:MM)").setRequired(true))
    .addStringOption((o) => o.setName("aircraft-type").setDescription("The aircraft type.").setRequired(true))
    .addUserOption((o) => o.setName("captain").setDescription("Select the captain assigned for the flight."))
    .addUserOption((o) => o.setName("first-officer").setDescription("Select the first officer assigned for the flight."))
    .addUserOption((o) => o.setName("additional-crew-member").setDescription("Select any additional assigned crew for the flight.").setRequired(false))
    .addUserOption((o) => o.setName("cabin-crew").setDescription("Select cabin crew assigned for the flight.").setRequired(false))
    .addChannelOption((o) => o.setName("vc-channel").setDescription("Select VC channel that the flight will be hosted in.").addChannelTypes(ChannelType.GuildVoice))
    .addStringOption((o) => o.setName("departure-terminal").setDescription("Departure Terminal"))
    .addStringOption((o) => o.setName("departure-gate").setDescription("Enter the departure gate."))
    .addStringOption((o) => o.setName("checkin-row").setDescription("Enter the Check-in Row (Counter Check-in only)").setRequired(false))
    .addBooleanOption((o) => o.setName("ping-role").setDescription("Ping the role in the announcement?").setRequired(false)),
  new SlashCommandBuilder()
    .setName("atis-text")
    .setDescription("Get full METAR and runway recommendations")
    .addStringOption((option) =>
      option
        .setName("icao")
        .setDescription("Enter the ICAO code (e.g. WSSS)")
        .setRequired(true),
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

  // ------------------ Flight Search ------------------
  if (interaction.commandName === "flight-search") {
    let flightNo = mapFlightNumber(interaction.options.getString("flight-number").toUpperCase());
    try {
      const res = await fetch(`http://api.aviationstack.com/v1/flights?access_key=${process.env.AVIATIONSTACK_KEY}&flight_iata=${flightNo}`);
      const data = await res.json();
      if (!data.data || data.data.length === 0) {
        await interaction.reply({ content: `Flight **${flightNo}** not found.`, ephemeral: true });
        return;
      }

      const f = data.data[0];
      const status = getStatus(f);
      const aircraft = f.aircraft?.icao || f.aircraft?.iata || "N/A";
      const registration = f.aircraft?.registration || "N/A";

      const embed = new EmbedBuilder()
        .setColor(0x1e90ff)
        .setTitle(`✈️ Flight ${f.flight.iata}/${f.flight.icao}`)
        .addFields(
          { name: "Flight Status", value: status, inline: true },
          { name: "Aircraft Type", value: aircraft, inline: true },
          { name: "Aircraft Registration", value: registration, inline: true },
          {
            name: "Departure",
            value: `${f.departure.airport} (${f.departure.iata})(${f.departure.icao})\nTerminal: ${f.departure.terminal || "N/A"}\nGate: ${f.departure.gate || "N/A"}\nScheduled: ${formatUTC(f.departure.scheduled)}\nEstimated: ${formatUTC(f.departure.estimated)} (UTC)`,
          },
          {
            name: "Arrival",
            value: `${f.arrival.airport} (${f.arrival.iata})(${f.arrival.icao})\nTerminal: ${f.arrival.terminal || "N/A"}\nGate: ${f.arrival.gate || "N/A"}\nScheduled: ${formatUTC(f.arrival.scheduled)}\nEstimated: ${formatUTC(f.arrival.estimated)} (UTC)`,
          },
        )
        .setFooter({ text: "IN TESTING. FSOps Virtual Bot" });

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching flight **${flightNo}**.`, ephemeral: true });
    }
  }

  // ------------------ METAR ------------------
  if (interaction.commandName === "metar") {
    const icao = interaction.options.getString("icao").toUpperCase();
    const format = interaction.options.getString("format") || "formatted";
    try {
      const res = await fetch(`https://api.checkwx.com/metar/${icao}/decoded`, { headers: { "X-API-Key": process.env.CHECKWX_KEY } });
      const data = await res.json();
      if (!data.results || data.results === 0) {
        await interaction.reply({ content: `No METAR found for ${icao}.`, ephemeral: true });
        return;
      }

      const metar = data.data[0];
      const rawText = metar.raw_text || "N/A";
      const wind = metar.wind?.degrees && metar.wind?.speed_kts ? `${metar.wind.degrees}° ${metar.wind.speed_kts}KT` : "N/A";
      const temp = metar.temperature?.celsius ?? "N/A";
      const dew = metar.dewpoint?.celsius ?? "N/A";
      const vis = metar.visibility?.miles_text ?? "N/A";
      const qnh = metar.barometer?.hpa ?? "N/A";
      const clouds = metar.clouds?.map((c) => `${c.text} at ${c.feet}ft`).join(", ") || "N/A";

      const embed = new EmbedBuilder().setTitle(`METAR ${icao}`).setColor(0x1e90ff);

      if (format === "raw") {
        embed.addFields({ name: "Raw METAR", value: `\`\`\`${rawText}\`\`\`` });
      } else {
        embed.addFields(
          { name: "Wind", value: wind, inline: true },
          { name: "Temperature", value: `${temp}°C`, inline: true },
          { name: "Dewpoint", value: `${dew}°C`, inline: true },
          { name: "Visibility", value: vis, inline: true },
          { name: "Pressure (QNH)", value: `${qnh} hPa`, inline: true },
          { name: "Clouds", value: clouds },
          { name: "Raw METAR", value: `\`\`\`${rawText}\`\`\`` },
        );
      }

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching METAR for ${icao}.`, ephemeral: true });
    }
  }

  // ------------------ TAF ------------------
  if (interaction.commandName === "taf") {
    const icao = interaction.options.getString("icao").toUpperCase();
    const format = interaction.options.getString("format") || "formatted";
    try {
      const res = await fetch(`https://api.checkwx.com/taf/${icao}/decoded`, { headers: { "X-API-Key": process.env.CHECKWX_KEY } });
      const data = await res.json();
      if (!data.results || data.results === 0) {
        await interaction.reply({ content: `No TAF found for ${icao}.`, ephemeral: true });
        return;
      }

      const taf = data.data[0];
      const rawText = taf.raw_text || "N/A";

      const embed = new EmbedBuilder().setTitle(`TAF ${icao}`).setColor(0x1e90ff);

      if (format === "raw") {
        embed.addFields({ name: "Raw TAF", value: `\`\`\`${rawText}\`\`\`` });
      } else {
        embed.addFields(
          { name: "Forecast Summary", value: taf.forecast?.map(f => `From ${f.from} to ${f.to}: ${f.text}`).join("\n") || rawText },
          { name: "Raw TAF", value: `\`\`\`${rawText}\`\`\`` },
        );
      }

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching TAF for ${icao}.`, ephemeral: true });
    }
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

      const runways = pickRunways(icao, windDeg);
      const runwayText = runways.map(r => `${r.name} ${r.preferredDeparture ? "(Preferred Departure)" : ""}${r.preferredArrival ? " (Preferred Arrival)" : ""}`).join(", ") || "No compatible runways found";

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
          { name: "Compatible Runways", value: runwayText },
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
