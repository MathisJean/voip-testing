const AriClient = require('ari-client');
const { STATUS, load_agents } = require("./agent_script"); //TODO: Add dynamic agents from asterisk conf files

const ARI_URL = "http://localhost:8088/ari";
const AUTH = { username: "ari_user", password: "strongpassword" };

const QUEUE = new Map();
const PROCESSING_ETA = 120; //Temp var

class Agent
{
    constructor(endpoint)
    {
        this.status = STATUS.AVAILABLE,
        this.endpoint = endpoint
    }

    setBusy() { this.status = STATUS.BUSY; }
    setAvailable() { this.status = STATUS.AVAILABLE; }
    setOffline() { this.status = STATUS.OFFLINE; }
}

const AGENTS = 
[
    new Agent('1002-agent')
]

const CHANNEL_BRIDGE = new Map();

let is_agent;

//Connect to Asterisk server
AriClient.connect(ARI_URL, AUTH.username, AUTH.password)
.then(client =>
{
    //Start myapp
    client.start('myapp');
    console.log("Connected to ARI");

    //Log on disconnect
    client.on('disconnect', () =>
    {
        console.log("Connection closed");
    });

    //Log Asterisk server error
    client.on('error', (err) => 
    {
        console.error("WebSocket error:", err);
    });

    client.on('StasisStart', async (event, channel) =>
    {
        //If softphone is called from the server
        is_agent = event.args[0] === "dialed";

        //Run client logic
        if(!is_agent)
        {
            channel.on("ChannelDtmfReceived", (event, channel) =>
            {
              const digit = event.digit;
        
              console.log(`Caller pressed: ${digit}`);
        
                if(digit === "1") queue_length(channel);
                if(digit === "2") toggle_hold_bridge(client, channel)
            });

            client_logic(client, channel);
        }
    });
});

async function client_logic(client, channel)
{
    await channel.answer();

    //No agents online
    if(AGENTS.length <= 0) console.log("No agents online, please call again later"); //TODO: Add open hours

    //Find an available agent
    const AGENT = AGENTS.find(a => a.status === STATUS.AVAILABLE);

    //No available agents -> add to queue
    if(!AGENT)
    {
        console.log('No available agents, adding to queue');
        add_queue(client, channel, null, false);
        return;
    }

    add_queue(client, channel, AGENT.endpoint, false);
    AGENT.setBusy();

    //Declare agent channel to acces it from client side
    let agent_channel;

    //Dial agent
    try
    {
        agent_channel = await client.channels.originate({
            endpoint: `PJSIP/${AGENT.endpoint}`,
            app: 'myapp',
            appArgs: 'dialed',
            callerId: 'Support Agent'
        });
    }
    catch(err)
    {
        console.error('Failed to originate agent call:', err);
        AGENT.setAvailable(); //Free up agent

        await channel.hangup().catch(() => {});
        channel.removeAllListeners();

        CHANNEL_BRIDGE.delete(channel.id);
        return;
    }

    //Hangup agent when client ends call
    channel.on('StasisEnd', async () =>
    {
        if(agent_channel)
        {
            await agent_channel.hangup().catch(() => {});
            agent_channel.removeAllListeners();

            CHANNEL_BRIDGE.delete(channel.id);
            remove_queue(channel);
        }
    });

    //When agent is connected, add channels to bridge
    agent_channel.on('StasisStart', async () =>
    {
        //Creates a bridge for communications
        let bridge = await client.bridges.create({type: 'mixing'});

        //Destroy bridge on end of call
        agent_channel.on('StasisEnd', async () =>
        {
            await bridge.destroy();
        });

        await channel.answer();
        await bridge.addChannel({channel: channel.id});        
        await bridge.addChannel({channel: agent_channel.id});    
        
        add_queue(client, channel, null, true);
    });

    //Hangup client when agent ends call
    agent_channel.on('ChannelDestroyed', async () =>
    {
        await channel.hangup().catch(() => {});
        channel.removeAllListeners();

        CHANNEL_BRIDGE.delete(channel.id);
        remove_queue(channel);

        AGENT.setAvailable();

        //Delay before getting next client
        setTimeout(async () => {await get_next(client)}, 1000);
    });
}

//Gets the next in queue before calling them
async function get_next(client)
{
    for(const [id, data] of QUEUE.entries())
    {
        if(!data.agentEndpoint && !data.bridged)
        {
            try
            {
                const channel = await client.channels.get({ channelId: id });
                await client_logic(client, channel);
            }
            catch(err)
            {
                console.error(`Failed to get or connect channel ${id}:`, err);
            }

            break;
        }
    }
}

//Add or update a channel to or from the queue
async function add_queue(client, channel, agent, bridged)
{
    //If channel is new or prexisting
    const IN_QUEUE = QUEUE.get(channel.id) || {};

    //Keeping original values if null is input
    agent = agent == null ? IN_QUEUE.agentEndpoint ?? null : agent;
    bridged = bridged == null ? IN_QUEUE.bridged ?? false : bridged;

    //Update or create key value
    QUEUE.set(channel.id, { agentEndpoint: agent, bridged: bridged });

    //If not in queue
    if(!agent)
    {
        //Add to bridge
        add_hold_bridge(client, channel);
    }
}

//Remove a channel from the queue
function remove_queue(channel)
{
    QUEUE.delete(channel.id);
}

//Print queue position and statistics
function queue_length(channel)
{
    //Queue sixe and position
    let queue_size = QUEUE.size;
    let queue_pos = 1;

    //Loop through every waiting client
    for(const [key, value] of QUEUE)
    {
        //End when channel is found
        if(key === channel.id) break;

        //Only count waiting clients
        else if(value.agentEndpoint === null && value.bridged === false) queue_pos++;
    }

    //Rough estimate of wait time TODO: Improve with real ETA
    let eta = Math.max(((queue_pos / AGENTS.length) * PROCESSING_ETA), PROCESSING_ETA)

    console.log("You are " + queue_pos + " out of " + queue_size + " in the queue. ETA : " + eta)
}

//Function to add a channel to hold bridge
async function add_hold_bridge(client, channel)
{
    const BRIDGES = await client.bridges.list();
    let bridge = BRIDGES.find(b => b.name === 'queue_music');

    //If there is no bridge
    if(!bridge)
    {
        bridge = await client.bridges.create(
        {
            type: 'holding',
            name: 'queue_music'
        });
    }

    //Adds channel to bridge
    try
    {
        await bridge.addChannel({ channel: channel.id });
        CHANNEL_BRIDGE.set(channel.id, bridge.id);
    }
    catch(err)
    {
        //Cleanup
        console.error(`Couldn't add channel ${channel.id} to bridge ${new_bridge.id}`)
        await channel.hangup().catch(() => {});
        channel.removeAllListeners();

        CHANNEL_BRIDGE.delete(channel.id);
        remove_queue(channel);
    }
}

//Function to switch bridge from channel
async function toggle_hold_bridge(client, channel)
{
    const CURRENT_BRIDGE_ID = CHANNEL_BRIDGE.get(channel.id);
    const CURRENT_BRIDGE = await client.bridges.get({ bridgeId: CURRENT_BRIDGE_ID });

    //Switches queue_music <=> queue_silent
    bridge_name = CURRENT_BRIDGE.name === 'queue_music' ? 'queue_silent' : 'queue_music';

    //Remove channel from current bridge
    try
    {
        await CURRENT_BRIDGE.removeChannel({ channel: channel.id });
        CHANNEL_BRIDGE.delete(channel.id)
    }
    catch(err)
    {
        console.error(`Could not remove channel ${channel.id} from bridge ${CURRENT_BRIDGE_ID}:`, err.message);
        return;
    }

    //Get new bridge
    const BRIDGES = await client.bridges.list();
    let new_bridge = BRIDGES.find(b => b.name === bridge_name);

    if(!new_bridge)
    {
        //Creates new bridge if it doesn't exist
        new_bridge = await client.bridges.create(
        {
            type: 'holding',
            name: bridge_name
        });
    }

    //Adds channel to new bridge
    try
    {
        await new_bridge.addChannel({ channel: channel.id });
        CHANNEL_BRIDGE.set(channel.id, new_bridge.id)
    }
    catch(err)
    {
        //Cleanup
        console.error(`Couldn't add channel ${channel.id} to bridge ${new_bridge.id}`);
        await channel.hangup().catch(() => {});
        channel.removeAllListeners();

        CHANNEL_BRIDGE.delete(channel.id);
        remove_queue(channel);
    }
}