module.exports = {
  formatedUptime: (seconds) => {
    const numdays = Math.floor(seconds / 86400);
    const numhours = Math.floor((seconds % 86400) / 3600);
    const numminutes = Math.floor(((seconds % 86400) % 3600) / 60);
    const numseconds = Math.floor((seconds % 86400) % 3600) % 60;
    const upTime = `${numdays} days ${numhours} hours ${numminutes} minutes ${numseconds} seconds`;
    return upTime;
  }
};
