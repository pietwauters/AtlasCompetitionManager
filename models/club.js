const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Club = sequelize.define('Club', {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    city: DataTypes.STRING,
    country: DataTypes.STRING
  });
  Club.associate = models => {
    Club.hasMany(models.Person, { foreignKey: 'clubId' });
    // No direct association to Fencer; Fencer is always a Person
  };
  return Club;
};
