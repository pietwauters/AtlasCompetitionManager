const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Person = sequelize.define('Person', {
    firstName: DataTypes.STRING,
    lastName: DataTypes.STRING,
    birthdate: DataTypes.DATE,
    clubId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Clubs',
        key: 'id'
      }
    },
    nationality: {
      type: DataTypes.STRING(3),
      references: {
        model: 'NOCs',
        key: 'code'
      }
    },
    gender: DataTypes.STRING(1) // M or F
  });
  Person.associate = models => {
    Person.hasMany(models.Fencer, { foreignKey: 'personId' });
    Person.belongsTo(models.NOC, { foreignKey: 'nationality', targetKey: 'code' });
    Person.belongsTo(models.Club, { foreignKey: 'clubId' });
    // Add other roles here as needed
  };
  return Person;
};
