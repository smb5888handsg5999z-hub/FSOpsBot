import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
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
      type: 0 // Playing
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

// ===================== 4️⃣ Runway / ATIS Logic =====================
const airportRunways = {
  WSSS: [
    { name: "02L", enabled: true, preferredDeparture: false, preferredArrival: true },
    { name: "02C", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "02R", enabled: false, preferredDeparture: false, preferredArrival: false },
    { name: "20L", enabled: false, preferredDeparture: false, preferredArrival: false },
    { name: "20R", enabled: true, preferredDeparture: false, preferredArrival: true },
    { name: "20C", enabled: true, preferredDeparture: true, preferredArrival: false },
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

// Fetch runways from AirportDB API
async function fetchRunwaysOnline(icao) {
  try {
    const res = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${process.env.AIRPORTDB_KEY}`);
    if (!res.ok) {
      console.error(`AirportDB API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!data || !data.runways || data.runways.length === 0) return [];

    return data.runways.map(rwy => ({
      name: rwy.le_ident || rwy.he_ident,
      enabled: rwy.closed === "0",
      preferredDeparture: false,
      preferredArrival: false,
      heading: parseFloat(rwy.le_heading_degT || rwy.he_heading_degT || 0),
    }));
  } catch (err) {
    console.error(`Error fetching runways for ${icao}:`, err);
    return [];
  }
}

// Hybrid runway lookup: local DB first, fallback to AirportDB API
async function pickRunways(icao, windDeg) {
  let dbRunways = airportRunways[icao];
  let fromDatabase = true;

  if (!dbRunways) {
    dbRunways = await fetchRunwaysOnline(icao);
    fromDatabase = false;
  }

  const departure = [];
  const arrival = [];

  dbRunways.forEach((rwy) => {
    const hdg = rwy.heading || runwayHeading(rwy.name);
    if (rwy.enabled && isRunwayAligned(hdg, windDeg)) {
      if (rwy.preferredDeparture || !fromDatabase) departure.push(rwy.name);
      if (rwy.preferredArrival || !fromDatabase) arrival.push(rwy.name);
    }
  });

  const note = fromDatabase ? "" : " (from AirportDB)";
  return {
    departure: departure.length ? departure.join(", ") + note : "None" + note,
    arrival: arrival.length ? arrival.join(", ") + note : "None" + note,
  };
}

// ===================== 5️⃣ Slash Commands =====================
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Ping the bot"),
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
          { name: "Raw", value: "raw" }
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
          { name: "Raw", value: "raw" }
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
  new SlashCommandBuilder()
    .setName("flightannounce")
    .setDescription("Send a flight announcement")
    .addChannelOption(option => option.setName("channel").setDescription("Announcement channel").setRequired(true))
    .addStringOption(option => option.setName("status").setDescription("Booking / Boarding etc").setRequired(true))
    .addStringOption(option => option.setName("airline").setDescription("Airline").setRequired(true))
    .addStringOption(option => option.setName("flight_number").setDescription("Flight Number").setRequired(true))
    .addStringOption(option => option.setName("departure_airport").setDescription("Departure ICAO").setRequired(true))
    .addStringOption(option => option.setName("arrival_airport").setDescription("Arrival ICAO").setRequired(true))
    .addBooleanOption(option => option.setName("non_stop").setDescription("Non-stop flight").setRequired(false))
    .addStringOption(option => option.setName("duration").setDescription("Flight duration").setRequired(false))
    .addStringOption(option => option.setName("departure_time").setDescription("Departure time (YYYY-MM-DD HH:mm)").setRequired(true))
    .addStringOption(option => option.setName("arrival_time").setDescription("Arrival time (YYYY-MM-DD HH:mm)").setRequired(true))
    .addStringOption(option => option.setName("aircraft_type").setDescription("Aircraft type").setRequired(true))
    .addUserOption(option => option.setName("captain").setDescription("Captain"))
    .addUserOption(option => option.setName("first_officer").setDescription("First Officer"))
    .addUserOption(option => option.setName("additional_crew_member").setDescription("Additional crew member"))
    .addUserOption(option => option.setName("cabin_crew").setDescription("Cabin crew"))
    .addChannelOption(option => option.setName("vc_channel").setDescription("VC channel"))
    .addStringOption(option => option.setName("departure_terminal").setDescription("Departure terminal"))
    .addStringOption(option => option.setName("departure_gate").setDescription("Departure gate"))
    .addStringOption(option => option.setName("checkin_row").setDescription("Check-in row"))
    .addBooleanOption(option => option.setName("ping_role").setDescription("Ping role or not")),
].map(c => c.toJSON());

// ===================== 6️⃣ Register Commands =====================
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("Commands successfully registered!");
  } catch (err) {
    console.error(err);
  }
})();

// ===================== 7️⃣ Command Handling =====================
client.on("interactionCreate", async interaction => {
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
      const clouds = metar.clouds?.map(c => `${c.text} at ${c.feet}ft`).join(", ") || "N/A";

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
          { name: "Forecast Summary", value: taf.forecast?.map(f => `• ${f.wind_direction_degrees || "N/A"}° ${f.wind_speed_kt || "N/A"}KT | ${f.clouds?.map(c => c.text).join(", ") || "N/A"}`).join("\n") || "N/A" },
          { name: "Raw TAF", value: `\`\`\`${rawText}\`\`\`` }
        );
      }

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching TAF for ${icao}.`, ephemeral: true });
    }
  }

  // ------------------ ATIS & Runways ------------------
  if (interaction.commandName === "atis-text") {
    const icao = interaction.options.getString("icao").toUpperCase();
    try {
      const res = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${process.env.AIRPORTDB_KEY}`);
      const data = await res.json();

      if (!data || !data.freqs || !data.runways) {
        await interaction.reply({ content: `No ATIS/runway info found for ${icao}.`, ephemeral: true });
        return;
      }

      const atis = data.freqs.find(f => f.type === "ATIS")?.frequency_mhz ?? "N/A";
      const windDeg = Math.floor(Math.random() * 360); // You can replace with METAR wind deg if available
      const runways = await pickRunways(icao, windDeg);

      const embed = new EmbedBuilder()
        .setTitle(`ATIS & Runways for ${icao}`)
        .setColor(0x1e90ff)
        .addFields(
          { name: "ATIS Frequency", value: `${atis} MHz`, inline: true },
          { name: "Recommended Runways (Departure)", value: runways.departure, inline: true },
          { name: "Recommended Runways (Arrival)", value: runways.arrival, inline: true },
        );

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching ATIS/runway for ${icao}.`, ephemeral: true });
    }
  }

  // ------------------ Flight Announce ------------------
  if (interaction.commandName === "flightannounce") {
    const channel = interaction.options.getChannel("channel");
    const status = interaction.options.getString("status");
    const airline = interaction.options.getString("airline");
    const flightNo = interaction.options.getString("flight_number");
    const depAirport = interaction.options.getString("departure_airport");
    const arrAirport = interaction.options.getString("arrival_airport");
    const nonStop = interaction.options.getBoolean("non_stop");
    const duration = interaction.options.getString("duration");
    const depDate = parseUTC(interaction.options.getString("departure_time"));
    const arrDate = parseUTC(interaction.options.getString("arrival_time"));
    const aircraft = interaction.options.getString("aircraft_type");

    if (!depDate || !arrDate) {
      await interaction.reply({ content: "❌ Invalid departure or arrival time. Use YYYY-MM-DD HH:mm", ephemeral: true });
      return;
    }

    const captain = interaction.options.getUser("captain");
    const firstOfficer = interaction.options.getUser("first_officer");
    const additionalCrewMember = interaction.options.getUser("additional_crew_member");
    const cabinCrew = interaction.options.getUser("cabin_crew");
    const vcChannel = interaction.options.getChannel("vc_channel");
    const depTerminal = interaction.options.getString("departure_terminal");
    const depGate = interaction.options.getString("departure_gate");
    const checkinRow = interaction.options.getString("checkin_row") || "N/A";
    const pingRole = interaction.options.getBoolean("ping_role") ?? true;

    const roleMention = pingRole ? "|| <@&1394622346933043292> ||" : "";
    const gateOpenUnix = Math.floor((depDate.getTime() - 3600000) / 1000); // 1 hour before dep
    const bookingUnix = Math.floor((depDate.getTime() - 48 * 3600000) / 1000);

    let msg = "";

    // ------------------ Status messages ------------------
    if (status === "booking") {
      msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${formatUTC(depDate)} – ${formatUTC(arrDate)}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

Economy Class tickets *on sale* from _SGD0_
Premium Economy Class tickets *on sale* from _SGD0_
Business Class tickets *on sale* from _SGD0_

Book by reacting with <:RSBST:1367435672658640946>
Choose a seat when check-in opens <t:${bookingUnix}:f> (<t:${bookingUnix}:R>)
Gate closes 15 minutes before departure.

${roleMention}`;
    } else if (status === "checkin") {
      msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${formatUTC(depDate)} – ${formatUTC(arrDate)}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

Check in now open. React with <:RSBST:1367435672658640946>

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabinCrew?.id}>
Hosted In: ${vcChannel?.toString()}
Departure Gate: ${depTerminal} ${depGate}

Gate Opens at <t:${gateOpenUnix}:f>
Gate Closes 15 minutes before departure.

${roleMention}`;
    } else if (status === "boarding") {
      msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${formatUTC(depDate)} – ${formatUTC(arrDate)}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

# Boarding at ${depTerminal} ${depGate}

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabinCrew?.id}>
Hosted In: ${vcChannel?.toString()}

Gate Closes 15 minutes before departure.

${roleMention}`;
    } else if (status === "gate_closed") {
      msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${formatUTC(depDate)} – ${formatUTC(arrDate)}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

# Gate Closed

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabin_crew?.id}>
Hosted In: ${vc_channel?.toString()}

Gate closes 15 minutes before departure.

${roleMention}`;
    } else if (status === "cancelled") {
      msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}

# This flight has been cancelled. ${airline} sincerely apologizes for any inconvenience caused.

${roleMention}`;
    }

    await channel.send({ content: msg });
    await interaction.reply({ content: `✅ Flight ${flightNo} announcement posted in ${channel}`, ephemeral: true });
  }
});

// ===================== 8️⃣ Login =====================
client.login(process.env.DISCORD_TOKEN);
