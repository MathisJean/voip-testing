
const STATUS = {
    BUSY: 0,
    AVAILABLE: 1,
    OFFLINE: 2,
}

async function load_agents(client)
{
    const channels = await client.channels.list;

    console.log(channels)
    
    const agent_channels = channels.filter(c => c.name.includes("agent"));
    
    console.log(agent_channels)
    
    const agent_info = agent_channels.map(c => ({
        id: c.id,
        status: STATUS.AVAILABLE
    }));
    
    console.log(agent_info)

    return agent_info    
}

module.exports = { load_agents, STATUS }