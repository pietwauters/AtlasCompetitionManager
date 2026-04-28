const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const NOC = sequelize.define('NOC', {
    code: {
      type: DataTypes.STRING(3),
      allowNull: false,
      unique: true
    },
    country: {
      type: DataTypes.STRING,
      allowNull: false
    }
  });
  NOC.associate = models => {
    NOC.hasMany(models.Person, { foreignKey: 'nationality' });
  };
  return NOC;
};
