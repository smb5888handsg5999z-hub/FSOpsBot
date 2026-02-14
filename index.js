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
app.get("/", (req, res) => res.send("FS Operations Bot is alive!"));
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

// ===================== CLIENT SETUP =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("ready", () => {
  console.log(`FS Operations online as ${client.user.tag}`);
  client.user.setPresence({
    status: "dnd",
    activities: [{ name: "SimBrief Dispatch", type: 0 }],
  });
});

// ===================== HELPERS =====================

// Map flight numbers (keep if you still use it)
const airlineMap = { SIA: "SQ", TGW: "TR", MAS: "MH", HVN: "VN", AXM: "AK" };
function mapFlightNumber(flightNo) {
  const prefix = flightNo.slice(0, 3);
  return airlineMap[prefix] ? airlineMap[prefix] + flightNo.slice(3) : flightNo;
}

// Format UTC nicely
function formatUTC(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return `${d.getUTCDate().toString().padStart(2,"0")}-${(d.getUTCMonth()+1).toString().padStart(2,"0")}-${d.getUTCFullYear()} ${d.getUTCHours().toString().padStart(2,"0")}:${d.getUTCMinutes().toString().padStart(2,"0")}`;
}

// Check if runway is aligned with wind
function isRunwayAligned(heading, windDeg) {
  if (windDeg === null) return true; // Variable wind
  const diff = Math.abs((heading - windDeg + 360) % 360);
  return diff <= 90;
}

// Get heading from runway string (e.g., 02L -> 20°)
function runwayHeading(rwyName) {
  const num = parseInt(rwyName.slice(0,2),10);
  return num*10;
}

// Local DB of runways
const airportRunways = {
  WSSS: [
    { name: "02L", enabled: true, preferredDeparture: false, preferredArrival: true },
    { name: "02C", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "02R", enabled: false, preferredDeparture: false, preferredArrival: false },
    { name: "20L", enabled: false, preferredDeparture: false, preferredArrival: false },
    { name: "20R", enabled: true, preferredDeparture: false, preferredArrival: true },
    { name: "20C", enabled: true, preferredDeparture: true, preferredArrival: false },
  ],
  WMKK: [
    { name: "15", enabled: true, preferredDeparture: true, preferredArrival: true },
    { name: "14R", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "14L", enabled: true, preferredDeparture: false, preferredArrival: true },
    { name: "33", enabled: true, preferredDeparture: true, preferredArrival: true },
    { name: "32L", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "32R", enabled: true, preferredDeparture: false, preferredArrival: true },
  ],
  VVTS: [
    { name: "07L", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "07R", enabled: true, preferredDeparture: false, preferredArrival: true },
    { name: "25L", enabled: true, preferredDeparture: true, preferredArrival: false },
    { name: "25R", enabled: true, preferredDeparture: false, preferredArrival: true },
  ],
};

// Fetch airport info from AirportDB (runways + IATA)
async function fetchAirportInfo(icao) {
  try {
    const res = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${process.env.AIRPORTDB_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data; // contains .iata and .runways
  } catch {
    return null;
  }
}

// Pick departure/arrival runways based on wind
function pickRunways(runways, windDeg, fromDatabase=true) {
  const departure = [];
  const arrival = [];

  runways.forEach((rwy) => {
    const hdg = rwy.heading || runwayHeading(rwy.name);
    if (rwy.enabled && isRunwayAligned(hdg, windDeg)) {
      if (rwy.preferredDeparture || !fromDatabase) departure.push(rwy.name);
      if (rwy.preferredArrival || !fromDatabase) arrival.push(rwy.name);
    }
  });

  const note =
    fromDatabase && departure.length === 0 && arrival.length === 0
      ? " (No preferential data)"
      : fromDatabase
      ? ""
      : " (from AirportDB)";
  
  return {
    departure: departure.length ? departure.join(", ") + note : "None" + note,
    arrival: arrival.length ? arrival.join(", ") + note : "None" + note
  };
}
// Fetch airport info from AirportDB
async function fetchAirportDB(icao) {
  try {
    const res = await fetch(`https://airportdb.io/api/v1/airport/${icao}?apiToken=${process.env.AIRPORTDB_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data; // contains .iata, .runways, .name, etc.
  } catch (err) {
    console.error(err);
    return null;
  }
}

// Format runway line
function formatRunwayLine(rwy) {
  const leHeading = rwy.le_heading_degT ?? "N/A";
  const heHeading = rwy.he_heading_degT ?? "N/A";

  const leILS = rwy.le_ils?.freq ? `${rwy.le_ils.freq} MHz` : "-";
  const heILS = rwy.he_ils?.freq ? `${rwy.he_ils.freq} MHz` : "-";

  const leStatus = rwy.closed === "1" ? "Closed" : "Open";
  const heStatus = rwy.closed === "1" ? "Closed" : "Open";

  const length = rwy.length_ft ?? "N/A";
  const width = rwy.width_ft ?? "N/A";

  return `${rwy.le_ident ?? "-"}    ${length}x${width} ft    ${leStatus}    ${leHeading}°    ${leILS}
${rwy.he_ident ?? "-"}    ${length}x${width} ft    ${heStatus}    ${heHeading}°    ${heILS}`;
}


// ===================== COMMANDS =====================
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Ping the bot"),

  new SlashCommandBuilder()
    .setName("flight-search")
    .setDescription("Search for flight information via AviationStack")
    .addStringOption((option) =>
      option.setName("flight-number")
            .setDescription("Enter the flight number (eg. SQ108)")
            .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("metar")
    .setDescription("Get METAR for an airport")
    .addStringOption((opt) => 
      opt.setName("icao")
         .setDescription("ICAO code")
         .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("taf")
    .setDescription("Get TAF for an airport")
    .addStringOption((opt) => 
      opt.setName("icao")
         .setDescription("ICAO code")
         .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("atis-text")
    .setDescription("Get full METAR, TAF, and runway info")
    .addStringOption((opt) => 
      opt.setName("icao")
         .setDescription("ICAO code")
         .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("flightannounce")
    .setDescription("Send a flight announcement")
    .addChannelOption((opt) => opt.setName("channel").setDescription("Announcement channel").setRequired(true))
    .addStringOption((opt) => opt.setName("status").setDescription("Booking / Boarding etc").setRequired(true))
    .addStringOption((opt) => opt.setName("airline").setDescription("Airline").setRequired(true))
    .addStringOption((opt) => opt.setName("flight_number").setDescription("Flight Number").setRequired(true))
    .addStringOption((opt) => opt.setName("departure_airport").setDescription("Departure ICAO").setRequired(true))
    .addStringOption((opt) => opt.setName("arrival_airport").setDescription("Arrival ICAO").setRequired(true))
    .addBooleanOption((opt) => opt.setName("non_stop").setDescription("Non-stop flight"))
    .addStringOption((opt) => opt.setName("duration").setDescription("Flight duration"))
    .addStringOption((opt) => opt.setName("departure_time").setDescription("Departure time (YYYY-MM-DD HH:mm)").setRequired(true))
    .addStringOption((opt) => opt.setName("arrival_time").setDescription("Arrival time (YYYY-MM-DD HH:mm)").setRequired(true))
    .addStringOption((opt) => opt.setName("aircraft_type").setDescription("Aircraft type").setRequired(true))
    .addUserOption((opt) => opt.setName("captain").setDescription("Captain"))
    .addUserOption((opt) => opt.setName("first_officer").setDescription("First Officer"))
    .addUserOption((opt) => opt.setName("additional_crew_member").setDescription("Additional crew member"))
    .addUserOption((opt) => opt.setName("cabin_crew").setDescription("Cabin crew"))
    .addChannelOption((opt) => opt.setName("vc_channel").setDescription("VC channel"))
    .addStringOption((opt) => opt.setName("departure_terminal").setDescription("Departure terminal"))
    .addStringOption((opt) => opt.setName("departure_gate").setDescription("Departure gate")),

  new SlashCommandBuilder()
    .setName("runways")
    .setDescription("Fetch all runways for an airport from AirportDB")
    .addStringOption(opt => 
      opt.setName("icao")
         .setDescription("ICAO code (e.g., WSSS)")
         .setRequired(true)
    )
].map(c => c.toJSON());

// ===================== REGISTER COMMANDS =====================
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("Commands successfully registered!");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

// ===================== COMMAND HANDLER =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ---------- PING ----------
  if (interaction.commandName === "ping") {
    const sent = await interaction.reply({ content: "Pinging...", fetchReply: true });
    const botLatency = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = interaction.client.ws.ping;
    const embed = new EmbedBuilder()
      .setColor(0x1e90ff)
      .setDescription(`${interaction.user} Pong!\nBot latency: ${botLatency}ms\nWebSocket: ${wsPing}ms`)
      .setFooter({ text: "IN TESTING. FS OPERATIONS BOT" })
      .setTimestamp();
    await interaction.editReply({ content: "", embeds: [embed] });
  }

  // ---------- METAR ----------
if (interaction.commandName === "metar") {
  const icao = interaction.options.getString("icao").toUpperCase();
  try {
    const res = await fetch(`https://api.checkwx.com/metar/${icao}/decoded`, {
      headers: { "X-API-Key": process.env.CHECKWX_KEY },
    });
    const data = await res.json();
    if (!data.results || data.results === 0)
      return interaction.reply({ content: `No METAR for ${icao}`, ephemeral: true });

    const metar = data.data[0];
    const embed = new EmbedBuilder()
      .setTitle(`${icao} METAR`)
      .setDescription(`\`\`\`${metar.raw_text}\`\`\``)
      .addFields(
        { name: "Temperature", value: `${metar.temperature?.celsius ?? "N/A"}°C`, inline: true },
        { name: "Dewpoint", value: `${metar.dewpoint?.celsius ?? "N/A"}°C`, inline: true },
        { name: "Wind", value: `${metar.wind?.degrees ?? "N/A"}° ${metar.wind?.speed_kts ?? "N/A"}KT`, inline: true },
        { name: "Visibility", value: `${metar.visibility?.meters ?? "N/A"} meters`, inline: true },
        { name: "Pressure (QNH)", value: `${metar.barometer?.hpa ?? "N/A"} hPa`, inline: true },
        { name: "Clouds", value: metar.clouds?.map(c => `${c.text} at ${c.feet}ft`).join(", ") ?? "N/A" }
      )
      .setColor(0x1e90ff)
      .setFooter({ text: "IN TESTING. FS OPERATIONS BOT" })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: `❌ Error fetching METAR for ${icao}`, ephemeral: true });
  }
}


  // ---------- TAF ----------
 if (interaction.commandName === "taf") {
  const icao = interaction.options.getString("icao").toUpperCase();
  try {
    const res = await fetch(`https://api.checkwx.com/taf/${icao}/decoded`, {
      headers: { "X-API-Key": process.env.CHECKWX_KEY },
    });
    const data = await res.json();
    if (!data.results || data.results === 0)
      return interaction.reply({ content: `No TAF for ${icao}`, ephemeral: true });

    const taf = data.data[0];
    const decoded = taf.forecast?.map(f => {
      const wind = f.wind_direction_degrees != null ? `${f.wind_direction_degrees}° ${f.wind_speed_kt ?? "N/A"}KT` : "N/A";
      const clouds = f.clouds?.map(c => c.text).join(", ") ?? "N/A";
      return `• Wind: ${wind} | Clouds: ${clouds}`;
    }).join("\n") ?? "N/A";

    const embed = new EmbedBuilder()
      .setTitle(`${icao} TAF`)
      .setDescription(`\`\`\`${taf.raw_text ?? "N/A"}\`\`\``)
      .addFields({ name: "Decoded Forecast", value: decoded })
      .setColor(0x1e90ff)
      .setFooter({ text: "IN TESTING. FS OPERATIONS BOT" })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: `❌ Error fetching TAF for ${icao}`, ephemeral: true });
  }
}


  // ---------- FLIGHT SEARCH ----------
  if (interaction.commandName === "flight-search") {
    const flightNo = interaction.options.getString("flight-number").toUpperCase();
    try {
      const res = await fetch(`https://aviationstack.com/api/v1/flights?access_key=${process.env.AVIATIONSTACK_KEY}&flight_iata=${flightNo}`);
      const data = await res.json();
      if (!data.data || data.data.length === 0) return interaction.reply({ content: `No flight found for ${flightNo}`, ephemeral: true });
      const f = data.data[0];
      const embed = new EmbedBuilder()
        .setTitle(`${flightNo} Flight Info`)
        .addFields(
          { name: "Airline", value: f.airline?.name ?? "N/A", inline: true },
          { name: "Departure", value: `${f.departure?.airport ?? "N/A"} (${f.departure?.iata ?? "N/A"})`, inline: true },
          { name: "Arrival", value: `${f.arrival?.airport ?? "N/A"} (${f.arrival?.iata ?? "N/A"})`, inline: true },
          { name: "Status", value: f.flight_status ?? "N/A", inline: true },
          { name: "Aircraft", value: f.aircraft?.icao ?? "N/A", inline: true },
          { name: "Scheduled Departure", value: f.departure?.scheduled ?? "N/A", inline: true },
          { name: "Scheduled Arrival", value: f.arrival?.scheduled ?? "N/A", inline: true }
        )
        .setColor(0x1e90ff)
        .setFooter({ text: "IN TESTING. FS OPERATIONS BOT" })
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching flight ${flightNo}`, ephemeral: true });
    }
  }
// ------------------ ATIS & Runways ------------------
if (interaction.commandName === "atis-text") {
  const icao = interaction.options.getString("icao").toUpperCase();

  try {
    // ---------- METAR ----------
    const metarRes = await fetch(`https://api.checkwx.com/metar/${icao}/decoded`, {
      headers: { "X-API-Key": process.env.CHECKWX_KEY },
    });
    const metarData = await metarRes.json();
    if (!metarData.results || metarData.results === 0)
      return interaction.reply({ content: `No METAR found for ${icao}`, ephemeral: true });
    const metar = metarData.data[0];
    const windDeg = metar.wind?.degrees ?? null;
    const windSpeed = metar.wind?.speed_kts ?? 0;

    // ---------- TAF ----------
    const tafRes = await fetch(`https://api.checkwx.com/taf/${icao}/decoded`, {
      headers: { "X-API-Key": process.env.CHECKWX_KEY },
    });
    const tafData = await tafRes.json();
    let rawTaf = "N/A";
    let decodedTaf = "N/A";
    if (tafData.results && tafData.results > 0) {
      const taf = tafData.data[0];
      rawTaf = taf.raw_text ?? "N/A";
      decodedTaf = taf.forecast?.map(f => {
        const windDir = f.wind_direction_degrees;
        const windSpd = f.wind_speed_kt;
        const wind = (windDir !== null && windDir !== undefined)
          ? `${windDir}° ${windSpd !== null && windSpd !== undefined ? windSpd : "0"}KT`
          : "N/A";
        const clouds = f.clouds?.map(c => c.text).join(", ") ?? "N/A";
        return `• Wind: ${wind} | Clouds: ${clouds}`;
      }).join("\n") ?? "N/A";
    }

// ---------- RUNWAYS ----------
let runways = airportRunways[icao]; // Local DB
let fromDatabase = true;

if (!runways) {
  try {
    const airportData = await fetchAirportInfo(icao);
    if (airportData && airportData.runways && airportData.runways.length > 0) {
      // Map both ends of each runway
      runways = airportData.runways.flatMap(rwy => [
        { 
          name: rwy.le_ident, 
          enabled: true, 
          preferredDeparture: false, 
          preferredArrival: false, 
          heading: parseFloat(rwy.le_heading_degT) 
        },
        { 
          name: rwy.he_ident, 
          enabled: true, 
          preferredDeparture: false, 
          preferredArrival: false, 
          heading: parseFloat(rwy.he_heading_degT) 
        }
      ]);
      fromDatabase = false;
    } else {
      // No runways from AirportDB
      runways = [];
    }
  } catch {
    runways = [];
  }
}

// ---------- PICK RUNWAYS ----------
function pickRunways(runways, windDeg) {
  if (!runways || runways.length === 0) return { departure: "N/A", arrival: "N/A" };

  // Filter runways aligned with wind
  const aligned = runways.filter(rwy => 
    rwy.enabled && (windDeg === null || angleDiff(rwy.heading, windDeg) <= 90)
  );

  // Departure/Arrival: pick all, prefer preferred if any
  const departure = aligned.filter(rwy => rwy.preferredDeparture).length
    ? aligned.filter(rwy => rwy.preferredDeparture)
    : aligned;

  const arrival = aligned.filter(rwy => rwy.preferredArrival).length
    ? aligned.filter(rwy => rwy.preferredArrival)
    : aligned;

  return {
    departure: departure.length ? departure.map(rwy => rwy.name).join(", ") : "N/A",
    arrival: arrival.length ? arrival.map(rwy => rwy.name).join(", ") : "N/A"
  };
}

// Helper for angle difference
function angleDiff(a, b) {
  let diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

const selectedRunways = pickRunways(runways, windDeg);

    // ---------- BUILD EMBED ----------
    const embed = new EmbedBuilder()
      .setTitle(`${icao} ATIS`)
      .addFields(
        { name: "RAW METAR", value: `\`\`\`${metar.raw_text ?? "N/A"}\`\`\`` },
        { name: "Wind", value: windDeg !== null ? `${windDeg}° ${windSpeed}KT` : `Variable ${windSpeed}KT`, inline: true },
        { name: "Temperature", value: `${metar.temperature?.celsius ?? "N/A"}°C`, inline: true },
        { name: "Dewpoint", value: `${metar.dewpoint?.celsius ?? "N/A"}°C`, inline: true },
        { name: "Visibility", value: `${metar.visibility?.meters ?? "N/A"} meters`, inline: true },
        { name: "Pressure (QNH)", value: `${metar.barometer?.hpa ?? "N/A"} hPa`, inline: true },
        { name: "Clouds", value: metar.clouds?.map(c => `${c.text} at ${c.feet}ft`).join(", ") ?? "N/A" },
        { name: "RAW TAF", value: `\`\`\`${rawTaf}\`\`\`` },
        { name: "Decoded TAF", value: decodedTaf },
        { name: "Preferred Departure Runway", value: selectedRunways.departure, inline: true },
        { name: "Preferred Arrival Runway", value: selectedRunways.arrival, inline: true }
      )
      .setColor(0x1e90ff)
      .setFooter({ text: "IN TESTING. FS OPERATIONS BOT" })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: `❌ Error fetching ATIS for ${icao}`, ephemeral: true });
  }
}

// ---------- FLIGHT ANNOUNCE ----------
if (interaction.commandName === "flightannounce") {
  const status = interaction.options.getString("status");
  const airline = interaction.options.getString("airline");
  const flightNo = interaction.options.getString("flight_number");
  const depAirport = interaction.options.getString("departure_airport");
  const arrAirport = interaction.options.getString("arrival_airport");
  const nonStop = interaction.options.getBoolean("non_stop");
  const duration = interaction.options.getString("duration");
  const depDateRaw = interaction.options.getString("departure_time");
  const arrDateRaw = interaction.options.getString("arrival_time");
  const aircraft = interaction.options.getString("aircraft_type");

  // Optional users/channels
  const captainUser = interaction.options.getUser("captain");
  const firstOfficerUser = interaction.options.getUser("first_officer");
  const additionalCrewUser = interaction.options.getUser("additional_crew_member");
  const cabinCrewUser = interaction.options.getUser("cabin_crew");
  const vcChannelObj = interaction.options.getChannel("vc_channel");
  const depTerminalRaw = interaction.options.getString("departure_terminal");
  const depGateRaw = interaction.options.getString("departure_gate");
  const channel = interaction.options.getChannel("channel");

  // Safe display variables
  const captain = captainUser ? `<@${captainUser.id}>` : "Not Assigned";
  const firstOfficer = firstOfficerUser ? `<@${firstOfficerUser.id}>` : "Not Assigned";
  const additionalCrewMember = additionalCrewUser ? `<@${additionalCrewUser.id}>` : "Not Assigned";
  const cabinCrew = cabinCrewUser ? `<@${cabinCrewUser.id}>` : "Not Assigned";
  const vcChannel = vcChannelObj ? vcChannelObj.toString() : "Not Assigned";
  const depTerminal = depTerminalRaw ?? "TBC";
  const depGate = depGateRaw ?? "TBC";

  // Safe timestamp parsing
  const depUnix = Math.floor(new Date(depDateRaw.replace(" ", "T") + ":00Z").getTime() / 1000);
  const arrUnix = Math.floor(new Date(arrDateRaw.replace(" ", "T") + ":00Z").getTime() / 1000);

  // Format UTC nicely
  const depFormatted = formatUTC(depDateRaw);
  const arrFormatted = formatUTC(arrDateRaw);

  let msg = "";

  if (status === "booking") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${depFormatted} – ${arrFormatted}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

Economy Class tickets *on sale* from _SGD0_
Premium Economy Class tickets *on sale* from _SGD0_
Business Class tickets *on sale* from _SGD0_

Book by reacting with <:RSBST:1367435672658640946>
Choose a seat when check-in opens <t:${depUnix}:f> (<t:${depUnix}:R>)
Gate closes 15 minutes before departure.

Captain: ${captain}
First Officer: ${firstOfficer}
Additional Crew: ${additionalCrewMember}
Cabin Crew: ${cabinCrew}
Hosted In: ${vcChannel}
Departure Gate: ${depTerminal} ${depGate}`;
  } else if (status === "checkin") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${depFormatted} – ${arrFormatted}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

Check in now open. React with <:RSBST:1367435672658640946>

Captain: ${captain}
First Officer: ${firstOfficer}
Additional Crew: ${additionalCrewMember}
Cabin Crew: ${cabinCrew}
Hosted In: ${vcChannel}
Departure Gate: ${depTerminal} ${depGate}

Gate Opens at <t:${depUnix}:f>
Gate Closes 15 minutes before departure.`;
  } else if (status === "boarding") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${depFormatted} – ${arrFormatted}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

# Boarding at ${depTerminal} ${depGate}

Captain: ${captain}
First Officer: ${firstOfficer}
Additional Crew: ${additionalCrewMember}
Cabin Crew: ${cabinCrew}
Hosted In: ${vcChannel}

Gate Closes 15 minutes before departure.`;
  } else if (status === "gate_closed") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}
**${depFormatted} – ${arrFormatted}**
-# Operated by ${airline}
Aircraft Type: ${aircraft}

# Gate Closed

Captain: ${captain}
First Officer: ${firstOfficer}
Additional Crew: ${additionalCrewMember}
Cabin Crew: ${cabinCrew}
Hosted In: ${vcChannel}
Departure Gate: ${depTerminal} ${depGate}`;
  } else if (status === "cancelled") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}

# This flight has been cancelled. ${airline} sincerely apologizes for any inconvenience caused.`;
  }

  await channel.send({ content: msg });
  await interaction.reply({ content: `✅ Flight ${flightNo} announcement posted in ${channel}`, ephemeral: true });
}
});

// ------------------ RUNWAYS ------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === "runways") {
    const icao = interaction.options.getString("icao").toUpperCase();

    try {
      const airport = await fetchAirportDB(icao);

      if (!airport) {
        await interaction.reply({ content: `❌ Airport ${icao} not found.`, ephemeral: true });
        return; // legal return inside a function
      }

      const name = airport.name ?? "N/A";
      const elevation = airport.elevation_ft ?? "N/A";

      if (!airport.runways || airport.runways.length === 0) {
        await interaction.reply({ content: `No runways found for ${icao}`, ephemeral: true });
        return;
      }

      const runwayLines = airport.runways.map(formatRunwayLine).join("\n");

      const embed = new EmbedBuilder()
        .setTitle(`${icao}/${airport.iata_code ?? "N/A"} Runways`)
        .setDescription(`*${name}*\n\n**Elevation:** ${elevation} ft AGL\n\n**Runway     Dimensions     Status     Heading     ILS**\n${runwayLines}\n\n*For runway preferences, use /atis-text*`)
        .setColor(0x1e90ff)
        .setFooter({ text: "IN TESTING. FS OPERATIONS BOT" })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });

    } catch (err) {
      console.error(err);
      await interaction.reply({ content: `❌ Error fetching runways for ${icao}`, ephemeral: true });
    }
  }
});


// ===================== LOGIN ===================== 
client.login(process.env.DISCORD_TOKEN);
