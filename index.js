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
  StringSelectMenuBuilder,
  ActionRowBuilder,
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
  
  // Set the "Playing" activity
  client.user.setActivity("SimBrief Dispatch", {
    type: ActivityType.Playing,
  });

  // Set the Custom Status (text) and the online status
  client.user.setPresence({
    activities: [
      {
        name: "SimBrief Dispatch",
        type: ActivityType.Playing,
      },
      {
        name: "Helping with your flight simulation needs",
        type: ActivityType.Custom,
        state: "Helping with your flight simulation needs",
      }
    ],
    status: "online",
  });
});

// ===================== 3️⃣ Helper Functions =====================
const airlineMap = { SIA: "SQ", TGW: "TR", MAS: "MH", HVN: "VN" };

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

  if (arrAct) return "Landed";
  if (!depAct) return "📅 Scheduled";
  if (depEst && depSch) {
    const diff = new Date(depEst) - new Date(depSch);
    if (diff > 5 * 60000) return "Delayed";
    if (diff < -5 * 60000) return "Early";
    return "On-Time";
  }
  return "Scheduled";
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

// ===================== 4️⃣ Slash Commands =====================
const commands = [
  new SlashCommandBuilder()
    .setName("flightsearch")
    .setDescription("Search for flight information using AviationStack")
    .addStringOption((option) =>
      option
        .setName("flight_number")
        .setDescription("Enter the flight number (eg. SQ108, SIA826")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("metar")
    .setDescription("Get METAR for an airport (raw/formated)")
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
    .setName("ping")
    .setDescription("Ping the bot"),
  new SlashCommandBuilder()
    .setName("flightannounce")
    .setDescription("Post a flight announcement!")
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
    .addStringOption((o) =>
      o.setName("airline").setDescription("Airline").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("flight_number")
        .setDescription("Enter the flight number")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("departure_airport")
        .setDescription("The departure airport")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("arrival_airport")
        .setDescription("The arrival airport")
        .setRequired(true),
    )
    .addBooleanOption((o) =>
      o
        .setName("non_stop")
        .setDescription("Is the flight non-stop?")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription("Duration of the flight (estimated block time)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("departure_time")
        .setDescription("Scheduled Departure Time (YYYY-MM-DD HH:MM)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("arrival_time")
        .setDescription("Scheduled Arrival time (YYYY-MM-DD HH:MM)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("aircraft_type")
        .setDescription("The aircraft type.")
        .setRequired(true),
    )
    .addUserOption((o) => o.setName("captain").setDescription("Select the captain assigned for the flight."))
    .addUserOption((o) =>
      o.setName("first_officer").setDescription("Select the first officer assigned for the flight."),
    )
    .addUserOption((o) =>
      o.setName("additional_crew_member").setDescription("Select any addidtional assigned crew for the flight.").setRequired(false)
    )
    .addUserOption((o) =>
      o.setName("cabin_crew").setDescription("Select cabin crew assigned for the flight.").setRequired(false),
    )
    .addChannelOption((o) =>
      o
        .setName("vc_channel")
        .setDescription("Select VC channel that the flight will be hosted in.")
        .addChannelTypes(ChannelType.GuildVoice),
    )
    .addStringOption((o) =>
      o.setName("departure_terminal").setDescription("Departure Terminal"),
    )
    .addStringOption((o) =>
      o.setName("departure_gate").setDescription("Enter the departure gate."),
    )
    .addStringOption((o) =>
      o
        .setName("checkin_row")
        .setDescription("Enter the Check-in Row (Counter Check-in only)").setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("discord_message_id")
        .setDescription("Discord Message Link for booking."),
    )
    .addBooleanOption((o) =>
      o
        .setName("ping_role")
        .setDescription("Ping the role in the announcement?")
        .setRequired(false),
    ),
].map((c) => c.toJSON());

// ===================== 5️⃣ Register Commands =====================
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  try {
    console.log("Currently registering commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("Commands have been successfully registered!");
  } catch (err) {
    console.error(err);
  }
})();

// ===================== 6️⃣ Handle Commands =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ===================== Handle Commands =====================
  if (interaction.commandName === "ping") {
    return interaction.reply({
      content: `${interaction.user} Pong!`,
    });
  }

  // ===================== Flight Search =====================
  if (interaction.commandName === "flightsearch") {
    let flightNo = mapFlightNumber(
      interaction.options.getString("flight_number").toUpperCase(),
    );
    try {
      const res = await fetch(
        `http://api.aviationstack.com/v1/flights?access_key=${process.env.AVIATIONSTACK_KEY}&flight_iata=${flightNo}`,
      );
      const data = await res.json();
      if (!data.data || data.data.length === 0) {
        await interaction.reply({
          content: `Flight **${flightNo}** not found. If you suspect an error, please DM @SG1695B_Avgeek`,
          ephemeral: true,
        });
        return;
      }

      const f = data.data[0];
      const status = getStatus(f);
      const aircraft = f.aircraft?.icao || f.aircraft?.iata || "N/A";
      const registration = f.aircraft?.registration || "N/A";

      const embed = new EmbedBuilder()
        .setColor(0x1e90ff)
        .setTitle(`✈️ Flight ${f.flight.iata}`)
        .addFields(
          { name: "Status", value: `${status}`, inline: true },
          { name: "Aircraft", value: `${aircraft}`, inline: true },
          { name: "Registration", value: `${registration}`, inline: true },
          {
            name: "Departure",
            value: `${f.departure.airport} (${f.departure.iata})\nTerminal: ${
              f.departure.terminal || "N/A"
            }\nGate: ${f.departure.gate || "N/A"}\nScheduled: ${formatUTC(
              f.departure.scheduled,
            )}\nEstimated: ${formatUTC(f.departure.estimated)}`,
          },
          {
            name: "Arrival",
            value: `${f.arrival.airport} (${f.arrival.iata})\nTerminal: ${
              f.arrival.terminal || "N/A"
            }\nGate: ${f.arrival.gate || "N/A"}\nScheduled: ${formatUTC(
              f.arrival.scheduled,
            )}\nEstimated: ${formatUTC(f.arrival.estimated)}`,
          },
        )
        .setFooter({ text: "FS Operations Virtual" });

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({
        content: `❌ Error fetching flight **${flightNo}**. Please DM @SG1695B_Avgeek if you suspect an error.`,
        ephemeral: true,
      });
    }
  }

  // ===================== METAR =====================
  if (interaction.commandName === "metar") {
    const icao = interaction.options.getString("icao").toUpperCase();
    const format = interaction.options.getString("format") || "formatted";
    try {
      const res = await fetch(`https://api.checkwx.com/metar/${icao}/decoded`, {
        headers: { "X-API-Key": process.env.CHECKWX_KEY },
      });
      const data = await res.json();
      if (!data.results || data.results === 0) {
        await interaction.reply({
          content: `Sorry, no METAR found for ${icao}. We aplogize for any inconvenience caused.`,
          ephemeral: true,
        });
        return;
      }

      const metar = data.data[0];
      const rawText = metar.raw_text || "N/A";
      const wind =
        metar.wind?.degrees && metar.wind?.speed_kts
          ? `${metar.wind.degrees}° ${metar.wind.speed_kts}KT`
          : "N/A";
      const temp = metar.temperature?.celsius ?? "N/A";
      const dew = metar.dewpoint?.celsius ?? "N/A";
      const vis = metar.visibility?.miles_text ?? "N/A";
      const qnh = metar.barometer?.hpa ?? "N/A";
      const clouds = metar.clouds
        ?.map((c) => `${c.text} at ${c.feet}ft`)
        .join(", ");

      const embed = new EmbedBuilder()
        .setTitle(`METAR ${icao}`)
        .setColor(0x1e90ff);

      if (format === "raw") {
        embed.addFields({ name: "Raw METAR", value: `\`\`\`${rawText}\`\`\`` });
      } else {
        embed.addFields(
          { name: "Wind", value: wind, inline: true },
          { name: "Temperature", value: `${temp}°C`, inline: true },
          { name: "Dewpoint", value: `${dew}°C`, inline: true },
          { name: "Visibility", value: vis, inline: true },
          { name: "Pressure (QNH)", value: `${qnh} hPa`, inline: true },
          { name: "Clouds", value: clouds || "N/A" },
          { name: "Raw METAR", value: `\`\`\`${rawText}\`\`\`` },
        );
      }

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({
        content: "Sorry, error fetching METAR for ${icao}. If you suspect an error, please DM @SG1695B_Avgeek. ",
        ephemeral: true,
      });
    }
  }

  // ===================== TAF =====================
  if (interaction.commandName === "taf") {
    const icao = interaction.options.getString("icao").toUpperCase();
    const format = interaction.options.getString("format") || "formatted";
    try {
      const res = await fetch(`https://api.checkwx.com/taf/${icao}/decoded`, {
        headers: { "X-API-Key": process.env.CHECKWX_KEY },
      });
      const data = await res.json();
      if (!data.results || data.results === 0) {
        await interaction.reply({
          content: `Sorry, no METAR found for ${icao}. We aplogize for any inconvenience caused.`,
          ephemeral: true,
        });
        return;
      }

      const taf = data.data[0];
      const rawText = taf.raw_text || "N/A";

      const embed = new EmbedBuilder()
        .setTitle(`TAF ${icao}`)
        .setColor(0x1e90ff);

      if (format === "raw") {
        embed.addFields({ name: "Raw TAF", value: `\`\`\`${rawText}\`\`\`` });
      } else {
        // formatted TAF
        let desc = `**Forecast:**\n`;
        if (taf.forecast) {
          taf.forecast.forEach((f, idx) => {
            desc += `• ${f.start_time} to ${f.end_time} — ${f.text || ""}\n`;
          });
        } else {
          desc += "N/A";
        }
        embed.setDescription(desc + `\n\nRaw TAF:\n\`\`\`${rawText}\`\`\``);
      }

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.reply({
        content: "❌ Error fetching TAF",
        ephemeral: true,
      });
    }
  }

  // ===================== Flight Announce =====================
  if (interaction.commandName === "flightannounce") {
    // variables
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
      await interaction.reply({
        content: "❌ Invalid departure or arrival time. Please use the format: YYYY-MM-DD HH:mm",
        ephemeral: true,
      });
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

    // --- Status Messages ---
    if (status === "booking") {
    msg = `# ${airline} ${flightNo}
  **${depAirport} – ${arrAirport}**
  ${nonStop ? "Non-stop • " : ""}${duration}

**${formatAirlineDate(depDate)} – ${formatAirlineDate(arrDate)}**
-# Operated by ${airline}

Aircraft Type: ${aircraft}

Economy Class tickets *on sale* from _SGD0_
Premium Economy Class tickets *on sale* from _SGD0_
Business Class tickets *on sale* from _SGD0_

Book this flight by reacting to **this message** with <:RSBST:1367435672658640946>
Choose a seat when check-in opens <t:${bookingUnix}:f> (<t:${bookingUnix}:R>)
Gate closes 15 minutes before departure.

    ${roleMention}`;
    } else if (status === "checkin") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}

**${formatAirlineDate(depDate)} – ${formatAirlineDate(arrDate)}**
-# Operated by ${airline}

Aircraft Type: ${aircraft}

Check in now open. Do check in by reacting to **this message** with <:RSBST:1367435672658640946>

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew Member: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabinCrew?.id}>

Hosted In: ${vcChannel?.toString()}

Departure Gate: ${depTerminal} ${depGate}

Gate Opens at <t:${gateOpenUnix}:f>
Gate Closes 15 minutes before departure.

     ${roleMention}`;
    } else if (status === "counter_checkin") {
      msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}

**${formatAirlineDate(depDate)} – ${formatAirlineDate(arrDate)}**
-# Operated by ${airline}

Aircraft Type: ${aircraft}

# Check-in now opened.

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew Member: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabinCrew?.id}>

Hosted In: ${vcChannel?.toString()}

Departure Gate: ${depTerminal} ${depGate}
Check-in Row: ${checkinRow}

Gate Opens at <t:${gateOpenUnix}:f>
Gate Closes 15 minutes before departure.

     ${roleMention}`;
    } else if (status === "boarding") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}

**${formatAirlineDate(depDate)} – ${formatAirlineDate(arrDate)}**
-# Operated by ${airline}

Aircraft Type: ${aircraft}

# Boarding at ${depTerminal} ${depGate}

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew Member: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabinCrew?.id}>

Hosted In: ${vcChannel?.toString()}

Gate Closes 15 minutes before departure.

${roleMention}`;
    } else if (status === "gate_closed") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}${duration}

**${formatAirlineDate(depDate)} – ${formatAirlineDate(arrDate)}**
-# Operated by ${airline}

Aircraft Type: ${aircraft}

# Gate Closed

Captain: <@${captain?.id}>
First Officer: <@${firstOfficer?.id}>
Additional Crew Member: <@${additionalCrewMember?.id}>
Cabin Crew: <@${cabinCrew?.id}>

Hosted In: ${vcChannel?.toString()}

Gate Closes 15 minutes before departure.

      ${roleMention}`;
    } else if (status === "cancelled") {
    msg = `# ${airline} ${flightNo}
**${depAirport} – ${arrAirport}**
${nonStop ? "Non-stop • " : ""}
-# Operated by ${airline}

# This flight has been cancelled. ${airline} sincerely apologizes for any inconvenience caused.
      
    ${roleMention}`;
    }

    await channel.send({ content: msg });
    await interaction.reply({
      content: `Success! ${flightNo} announcement has been posted in ${channel}`,
      ephemeral: true,
    });
  }
});

// ===================== 7️⃣ Login =====================
client.login(process.env.DISCORD_TOKEN);
