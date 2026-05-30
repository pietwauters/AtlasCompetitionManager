const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Referee = sequelize.define('Referee', {
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    licence: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'available'
    }
  }, {
    tableName: 'referees',
    timestamps: false
  });
  return Referee;
};
